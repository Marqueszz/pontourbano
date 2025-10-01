require('dotenv').config();
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const path = require('path');
const multer = require('multer');
const session = require('express-session');
const cloudinary = require('cloudinary').v2;

const app = express();
const PORT = process.env.PORT || 3000;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Configuração do PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Inicializar banco de dados
async function initDatabase() {
  try {
    const client = await pool.connect();
    console.log('Conexão com PostgreSQL estabelecida com sucesso!');

    // Criar tabelas se não existirem
    await client.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(100) NOT NULL,
        email VARCHAR(100) NOT NULL UNIQUE,
        senha VARCHAR(255) NOT NULL,
        foto_perfil VARCHAR(500),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS problemas (
        id SERIAL PRIMARY KEY,
        tipo VARCHAR(100) NOT NULL,
        descricao TEXT NOT NULL,
        data DATE NOT NULL,
        latitude NUMERIC(10, 8) NOT NULL,
        longitude NUMERIC(11, 8) NOT NULL,
        categoria VARCHAR(50) NOT NULL,
        foto VARCHAR(500),
        usuario_id INTEGER REFERENCES usuarios(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    client.release();
  } catch (error) {
    console.error('Erro ao conectar ao PostgreSQL:', error);
    process.exit(1);
  }
}

// Middleware
app.use(cors({
  origin: 'https://pontourbano.onrender.com',
  credentials: true
}));

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../frontend')));

// Sessão
app.use(session({
  secret: process.env.SESSION_SECRET || 'secret-temporario',
  resave: false,
  saveUninitialized: false,
  cookie: { 
    secure: false, 
    maxAge: 24 * 60 * 60 * 1000,
    httpOnly: true
  }
}));

// Multer para upload de imagens em memória (não salva no servidor)
const storage = multer.memoryStorage();
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limite
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Apenas arquivos de imagem são permitidos!'), false);
    }
  }
});

// Inicializa banco
initDatabase();

// Middleware de autenticação
const requireAuth = (req, res, next) => {
  if (req.session.userId) next();
  else res.status(401).json({ success: false, message: 'Não autorizado. Faça login primeiro.' });
};

// Rotas
app.get('/', (req, res) => res.sendFile(path.join(__dirname, '../frontend/index.html')));
app.get('/home', (req, res) => res.sendFile(path.join(__dirname, '../frontend/mapa.html')));

// Cadastro
app.post('/cadastro', upload.single('foto_perfil'), async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios' });

  try {
    const result = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (result.rows.length > 0) return res.status(400).json({ success: false, message: 'E-mail já cadastrado' });

    let fotoPerfilUrl = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCA2NDAgNjQwIj48cGF0aCBmaWxsPSIjMWE3M2U4IiBkPSJNMzIwIDMxMkMzODYuMyAzMTIgNDQwIDI1OC4zIDQ0MCAxOTJDNDQwIDEyNS43IDM4Ni4zIDcyIDMyMCA3MkMyNTMuNyA3MiAyMDAgMTI1LjcgMjAwIDE5MkMyMDAgMjU4LjMgMjUzLjcgMzEyIDMyMCAzMTJ6TTI5MC4zIDM2OEMxOTEuOCAzNjggMTEyIDQ0Ny44IDExMiA1NDYuM0MxMTIgNTYyLjcgMTI1LjMgNTc2IDE0MS43IDU3Nkw0OTguMyA1NzZDNTE0LjcgNTc2IDUyOCA1NjIuNyA1MjggNTQ2LjNDNTI4IDQ0Ny44IDQ0OC4yIDM2OCAzNDkuNyAzNjhMMjkwLjMgMzY4eiIvPjwvc3ZnPg==';

    // Se há uma foto de perfil, faz upload para o Cloudinary
    if (req.file) {
      try {
        const b64 = Buffer.from(req.file.buffer).toString('base64');
        const dataURI = "data:" + req.file.mimetype + ";base64," + b64;
        
        const uploadResult = await cloudinary.uploader.upload(dataURI, {
          folder: 'ponto-urbano-perfil',
          quality: 'auto',
          fetch_format: 'auto',
          transformation: [
            { width: 200, height: 200, crop: 'limit' }
          ]
        });
        fotoPerfilUrl = uploadResult.secure_url;
        console.log('Foto de perfil enviada para Cloudinary:', fotoPerfilUrl);
      } catch (cloudinaryError) {
        console.error('Erro no upload para Cloudinary:', cloudinaryError);
        return res.status(500).json({ 
          success: false, 
          message: 'Erro ao fazer upload da imagem de perfil', 
          error: cloudinaryError.message 
        });
      }
    }

    const hashedPassword = await bcrypt.hash(senha, 10);
    const insert = await pool.query(
      'INSERT INTO usuarios (nome, email, senha, foto_perfil) VALUES ($1, $2, $3, $4) RETURNING id, nome, email, foto_perfil',
      [nome, email, hashedPassword, fotoPerfilUrl]
    );

    const newUser = insert.rows[0];

    res.status(201).json({ 
      success: true, 
      message: 'Usuário criado com sucesso',
      user: {
        id: newUser.id,
        nome: newUser.nome,
        email: newUser.email,
        foto_perfil: newUser.foto_perfil
      }
    });
  } catch (error) {
    console.error('Erro no cadastro:', error);
    res.status(500).json({ success: false, message: 'Erro ao criar usuário', error: error.message });
  }
});

// Login
app.post('/login', async (req, res) => {
  const { email, senha } = req.body;
  if (!email || !senha) return res.status(400).json({ success: false, message: 'E-mail e senha são obrigatórios' });

  try {
    const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
    const users = result.rows;
    if (users.length === 0) return res.status(400).json({ success: false, message: 'E-mail ou senha incorretos' });

    const user = users[0];
    const match = await bcrypt.compare(senha, user.senha);
    if (!match) return res.status(400).json({ success: false, message: 'E-mail ou senha incorretos' });

    req.session.userId = user.id;
    req.session.userName = user.nome;
    req.session.userEmail = user.email;

    res.json({ 
      success: true, 
      message: 'Login realizado com sucesso', 
      user: { 
        id: user.id, 
        nome: user.nome, 
        email: user.email,
        foto_perfil: user.foto_perfil
      } 
    });
  } catch (error) {
    console.error('Erro no login:', error);
    res.status(500).json({ success: false, message: 'Erro ao fazer login', error: error.message });
  }
});

// Logout
app.post('/logout', (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ success: false, message: 'Erro ao fazer logout' });
    res.clearCookie('connect.sid');
    res.json({ success: true, message: 'Logout realizado com sucesso' });
  });
});

// Verificar autenticação
app.get('/auth/check', (req, res) => {
  if (req.session.userId) {
    res.json({ 
      authenticated: true, 
      user: { 
        id: req.session.userId, 
        nome: req.session.userName, 
        email: req.session.userEmail 
      } 
    });
  } else {
    res.json({ authenticated: false });
  }
});

// Rota para atualizar perfil do usuário (incluindo foto de perfil)
app.put('/perfil', requireAuth, upload.single('foto_perfil'), async (req, res) => {
  const { nome } = req.body;
  const userId = req.session.userId;
  let fotoPerfilUrl = null;

  try {
    // Se há uma nova foto de perfil, faz upload para o Cloudinary
    if (req.file) {
      try {
        const b64 = Buffer.from(req.file.buffer).toString('base64');
        const dataURI = "data:" + req.file.mimetype + ";base64," + b64;
        
        const uploadResult = await cloudinary.uploader.upload(dataURI, {
          folder: 'ponto-urbano-perfil',
          quality: 'auto',
          fetch_format: 'auto',
          transformation: [
            { width: 200, height: 200, crop: 'limit' }
          ]
        });
        fotoPerfilUrl = uploadResult.secure_url;
        console.log('Foto de perfil enviada para Cloudinary:', fotoPerfilUrl);
      } catch (cloudinaryError) {
        console.error('Erro no upload para Cloudinary:', cloudinaryError);
        return res.status(500).json({ 
          success: false, 
          message: 'Erro ao fazer upload da imagem de perfil', 
          error: cloudinaryError.message 
        });
      }
    }

    // Atualizar o usuário no banco
    let updateQuery;
    let queryParams;

    if (fotoPerfilUrl) {
      updateQuery = 'UPDATE usuarios SET nome = $1, foto_perfil = $2 WHERE id = $3 RETURNING id, nome, email, foto_perfil';
      queryParams = [nome, fotoPerfilUrl, userId];
    } else {
      updateQuery = 'UPDATE usuarios SET nome = $1 WHERE id = $2 RETURNING id, nome, email, foto_perfil';
      queryParams = [nome, userId];
    }

    const result = await pool.query(updateQuery, queryParams);
    const updatedUser = result.rows[0];

    // Atualizar a sessão
    req.session.userName = updatedUser.nome;

    res.json({ 
      success: true, 
      message: 'Perfil atualizado com sucesso',
      user: {
        id: updatedUser.id,
        nome: updatedUser.nome,
        email: updatedUser.email,
        foto_perfil: updatedUser.foto_perfil
      }
    });
  } catch (error) {
    console.error('Erro ao atualizar perfil:', error);
    res.status(500).json({ success: false, message: 'Erro ao atualizar perfil', error: error.message });
  }
});

// Rota para obter dados do usuário
app.get('/usuario/:id', async (req, res) => {
  try {
    const userId = req.params.id;
    const result = await pool.query(
      'SELECT id, nome, email, foto_perfil FROM usuarios WHERE id = $1',
      [userId]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
    }
    
    res.json({ success: true, user: result.rows[0] });
  } catch (error) {
    console.error('Erro ao buscar usuário:', error);
    res.status(500).json({ success: false, message: 'Erro ao buscar usuário', error: error.message });
  }
});

// Problemas - Listar
app.get('/problemas', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT p.*, u.nome as usuario_nome, u.foto_perfil as usuario_foto_perfil
      FROM problemas p
      LEFT JOIN usuarios u ON p.usuario_id = u.id
      ORDER BY p.created_at DESC
    `);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar problemas:', error);
    res.status(500).json({ success: false, message: 'Erro ao buscar problemas', error: error.message });
  }
});

// Problemas - Criar (com Cloudinary)
app.post('/problemas', requireAuth, upload.single('foto'), async (req, res) => {
  const { tipo, descricao, data, latitude, longitude, categoria } = req.body;
  const usuario_id = req.session.userId; // Obter o ID do usuário da sessão
  let fotoUrl = null;

  if (!tipo || !descricao || !data || latitude == null || longitude == null || !categoria) {
    return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios' });
  }

  try {
    // Se há uma foto, faz upload para o Cloudinary
    if (req.file) {
      try {
        const b64 = Buffer.from(req.file.buffer).toString('base64');
        const dataURI = "data:" + req.file.mimetype + ";base64," + b64;
        
        const uploadResult = await cloudinary.uploader.upload(dataURI, {
          folder: 'ponto-urbano',
          quality: 'auto',
          fetch_format: 'auto',
          transformation: [
            { width: 800, height: 600, crop: 'limit' }
          ]
        });
        fotoUrl = uploadResult.secure_url;
        console.log('Imagem enviada para Cloudinary:', fotoUrl);
      } catch (cloudinaryError) {
        console.error('Erro no upload para Cloudinary:', cloudinaryError);
        return res.status(500).json({ 
          success: false, 
          message: 'Erro ao fazer upload da imagem', 
          error: cloudinaryError.message 
        });
      }
    }

    const insert = await pool.query(
      'INSERT INTO problemas (tipo, descricao, data, latitude, longitude, categoria, foto, usuario_id) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id',
      [tipo, descricao, data, latitude, longitude, categoria, fotoUrl, usuario_id]
    );

    res.status(201).json({ 
      success: true, 
      message: 'Problema registrado com sucesso', 
      id: insert.rows[0].id, 
      foto: fotoUrl 
    });
  } catch (error) {
    console.error('Erro ao salvar problema:', error);
    res.status(500).json({ success: false, message: 'Erro ao salvar problema', error: error.message });
  }
});

// Endpoint para deletar uma imagem do Cloudinary (opcional, para administração)
app.delete('/problemas/:id/foto', requireAuth, async (req, res) => {
  try {
    const problemaId = req.params.id;
    
    // Buscar o problema para obter a URL da foto
    const result = await pool.query('SELECT foto FROM problemas WHERE id = $1', [problemaId]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Problema não encontrado' });
    }
    
    const fotoUrl = result.rows[0].foto;
    
    if (fotoUrl && fotoUrl.includes('cloudinary.com')) {
      // Extrair o public_id da URL do Cloudinary
      const parts = fotoUrl.split('/');
      const filename = parts[parts.length - 1];
      const publicId = 'ponto-urbano/' + filename.split('.')[0];
      
      // Deletar a imagem do Cloudinary
      await cloudinary.uploader.destroy(publicId);
    }
    
    // Atualizar o problema para remover a referência da foto
    await pool.query('UPDATE problemas SET foto = NULL WHERE id = $1', [problemaId]);
    
    res.json({ success: true, message: 'Foto removida com sucesso' });
  } catch (error) {
    console.error('Erro ao remover foto:', error);
    res.status(500).json({ success: false, message: 'Erro ao remover foto', error: error.message });
  }
});

// 404
app.use((req, res) => res.status(404).json({ success: false, message: 'Rota não encontrada' }));

// Erros gerais
app.use((err, req, res, next) => {
  console.error('Erro:', err.stack);
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, message: 'A imagem deve ter no máximo 5MB' });
    }
  }
  
  res.status(500).json({ success: false, message: 'Erro interno no servidor', error: err.message });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log('Cloudinary configurado:', process.env.CLOUDINARY_CLOUD_NAME ? 'Sim' : 'Não');
});