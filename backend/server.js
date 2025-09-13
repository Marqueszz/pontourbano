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

const app = express();
const PORT = process.env.PORT || 3000;

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
        foto VARCHAR(255),
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

// Multer para upload de imagens
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, '../frontend/uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});
const upload = multer({ storage: storage });

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
app.post('/cadastro', async (req, res) => {
  const { nome, email, senha } = req.body;
  if (!nome || !email || !senha) return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios' });

  try {
    const result = await pool.query('SELECT id FROM usuarios WHERE email = $1', [email]);
    if (result.rows.length > 0) return res.status(400).json({ success: false, message: 'E-mail já cadastrado' });

    const hashedPassword = await bcrypt.hash(senha, 10);
    const insert = await pool.query(
      'INSERT INTO usuarios (nome, email, senha) VALUES ($1, $2, $3) RETURNING id',
      [nome, email, hashedPassword]
    );

    res.status(201).json({ success: true, message: 'Usuário criado com sucesso' });
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

    res.json({ success: true, message: 'Login realizado com sucesso', user: { id: user.id, nome: user.nome, email: user.email } });
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
  if (req.session.userId) res.json({ authenticated: true, user: { id: req.session.userId, nome: req.session.userName, email: req.session.userEmail } });
  else res.json({ authenticated: false });
});

// Arquivos estáticos
app.use('/uploads', express.static(path.join(__dirname, '../frontend/uploads')));
app.use('/icons', express.static(path.join(__dirname, '../frontend/icons')));

// Problemas
app.get('/problemas', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM problemas ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (error) {
    console.error('Erro ao buscar problemas:', error);
    res.status(500).json({ success: false, message: 'Erro ao buscar problemas', error: error.message });
  }
});

app.post('/problemas', requireAuth, upload.single('foto'), async (req, res) => {
  const { tipo, descricao, data, latitude, longitude, categoria } = req.body;
  const fotoPath = req.file ? `uploads/${req.file.filename}` : null;

  if (!tipo || !descricao || !data || latitude == null || longitude == null || !categoria) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(400).json({ success: false, message: 'Todos os campos são obrigatórios' });
  }

  try {
    const insert = await pool.query(
      'INSERT INTO problemas (tipo, descricao, data, latitude, longitude, categoria, foto) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id',
      [tipo, descricao, data, latitude, longitude, categoria, fotoPath]
    );

    res.status(201).json({ success: true, message: 'Problema registrado com sucesso', id: insert.rows[0].id, foto: fotoPath });
  } catch (error) {
    if (req.file) fs.unlinkSync(req.file.path);
    console.error('Erro ao salvar problema:', error);
    res.status(500).json({ success: false, message: 'Erro ao salvar problema', error: error.message });
  }
});

// 404
app.use((req, res) => res.status(404).json({ success: false, message: 'Rota não encontrada' }));

// Erros gerais
app.use((err, req, res, next) => {
  console.error('Erro:', err.stack);
  res.status(500).json({ success: false, message: 'Erro interno no servidor', error: err.message });
});

// Iniciar servidor
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
