# 🖥️ ScreenShare — Plataforma estilo Discord Go Live

Compartilhamento de tela ao vivo no navegador, com lobby, streams simultâneas e integração com Discord Activities.

## Funcionalidades

- 📺 **Lobby** com cards de todas as transmissões ativas (thumbnail ao vivo, viewers, nome)
- 🔲 **Multi-stream** — assista várias telas ao mesmo tempo em um grid dinâmico
- 🔒 **Streams privadas** com senha
- 📱 **Mobile-friendly** — viewers podem assistir pelo celular
- ⚡ **WebRTC** — baixa latência, conexão direta

---

## Estrutura

```
screenshare-activity/
├── server/
│   ├── server.js       # Node.js — Express + WebSocket (signaling)
│   ├── package.json
│   └── .env.example
├── client/
│   ├── index.html      # Lobby + viewer (SPA)
│   ├── broadcast.html  # Página do broadcaster (abre em nova aba)
│   ├── style.css
│   ├── app.js
│   └── broadcast.js
└── README.md
```

---

## 🚀 Rodando localmente (para testar)

```bash
cd server
npm install
cp .env.example .env
node server.js
```

Acesse: `http://localhost:3000`

---

## 🌐 Deploy no VPS (Ubuntu/Debian)

### 1. Instalar Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Instalar PM2 (gerenciador de processo)

```bash
sudo npm install -g pm2
```

### 3. Fazer upload dos arquivos

```bash
# Via scp (do seu PC):
scp -r screenshare-activity/ user@seu-servidor:/home/user/screenshare

# Ou via git:
git clone https://github.com/seu-repo/screenshare-activity /home/user/screenshare
```

### 4. Instalar dependências e iniciar

```bash
cd /home/user/screenshare/server
npm install --production
cp .env.example .env
# Edite .env se quiser mudar a porta

pm2 start server.js --name screenshare
pm2 save
pm2 startup  # Para reiniciar automaticamente no boot
```

### 5. Configurar Nginx + HTTPS (Let's Encrypt)

```bash
sudo apt install nginx certbot python3-certbot-nginx
```

Crie `/etc/nginx/sites-available/screenshare`:

```nginx
server {
    server_name seu-dominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/screenshare /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx

# HTTPS gratuito com Let's Encrypt:
sudo certbot --nginx -d seu-dominio.com
```

Pronto! Acesse `https://seu-dominio.com` ✅

---

## 🎮 Integrar com Discord (Discord Activity)

O app já está pronto para rodar como Discord Activity!

### 1. Criar app no Discord Developer Portal

1. Acesse [discord.com/developers/applications](https://discord.com/developers/applications)
2. Clique em **"New Application"** → dê um nome (ex: "ScreenShare")
3. Vá em **"Activities"** no menu lateral
4. Ative o toggle **"Enable Activities"**
5. Em **"URL Mappings"**, adicione:
   - **Root Mapping**: `seu-dominio.com`
6. Copie o **Application ID**

### 2. Instalar o app no seu servidor Discord

1. Vá em **"OAuth2"** → **"URL Generator"**
2. Selecione scope: `applications.commands`
3. Copie a URL gerada e abra no navegador
4. Autorize no seu servidor Discord

### 3. Usar no Discord

1. Entre em um canal de voz
2. Clique no ícone 🚀 **Atividades**
3. Procure **"ScreenShare"** na lista
4. Clique para abrir — o lobby vai aparecer dentro do Discord!

> **Nota**: Para transmitir, clique em "Transmitir Tela" — isso abrirá uma aba normal do navegador (necessário porque iframes no Discord não têm permissão de captura de tela por padrão). Os viewers continuam assistindo dentro do Discord normalmente.

---

## Como funciona o compartilhamento múltiplo

1. No lobby, clique em qualquer stream para assistir
2. Você vai para a tela do viewer com o stream em tela cheia
3. Na **sidebar direita**, aparece a lista de outros streams disponíveis
4. Clique em outro stream na sidebar → ele é adicionado ao grid ao lado
5. O grid se ajusta automaticamente:
   - 1 stream → tela cheia
   - 2 streams → lado a lado
   - 3-4 → grade 2×2
   - 5-6 → grade 3×2

---

## Variáveis de ambiente (`.env`)

| Variável | Padrão | Descrição |
|----------|--------|-----------|
| `PORT` | `3000` | Porta do servidor |
