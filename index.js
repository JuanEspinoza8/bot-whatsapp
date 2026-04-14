const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = require('@whiskeysockets/baileys');
const { createClient } = require('@supabase/supabase-js');
const qrcode = require('qrcode-terminal'); // Volvió el generador de QR
require('dotenv').config();
const http = require('http');
const pino = require('pino');

// --- CONFIGURACIÓN DE SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL; 
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

const limpiarTexto = (texto) => {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
};

const formatearFecha = (fechaStr) => {
    const partes = fechaStr.split('/');
    if (partes.length !== 3) return null;
    return `${partes[2]}-${partes[1]}-${partes[0]}`;
};

async function iniciarBot() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_baileys');

    const sock = makeWASocket({
        auth: state,
        logger: pino({ level: 'silent' }), 
        browser: Browsers.macOS('Desktop'), // Disfraz oficial
        syncFullHistory: false,
        printQRInTerminal: false, // Lo apagamos acá porque lo dibujamos nosotros abajo
        generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;

        // DIBUJAMOS EL QR
        if (qr) {
            console.log('\n======================================================');
            qrcode.generate(qr, { small: true });
            console.log('¡Escaneá este QR rápido desde tu WhatsApp!');
            console.log('======================================================\n');
        }

        if (connection === 'close') {
            const reconectar = lastDisconnect.error?.output?.statusCode !== DisconnectReason.loggedOut;
            console.log('❌ Conexión cerrada. Error:', lastDisconnect.error?.message || "Desconocido");
            
            if (reconectar) {
                console.log('⏳ Intentando reconectar...');
                setTimeout(iniciarBot, 3000); 
            }
        } else if (connection === 'open') {
            console.log('✅ ¡Bot conectado exitosamente! Ya podés apagarlo con Ctrl+C');
        }
    });

    sock.ev.on('messages.upsert', async ({ messages }) => {
        const m = messages[0];
        if (!m.message) return;

        let rawText = m.message.conversation || m.message.extendedTextMessage?.text || "";
        if (!rawText) return;

        const texto = limpiarTexto(rawText);
        const idChat = m.key.remoteJid;
        const telefonoRemitente = m.key.participant || m.key.remoteJid;

        const responder = async (textoRespuesta) => {
            await sock.sendMessage(idChat, { text: textoRespuesta }, { quoted: m });
        };

        // --- COMANDOS ---
        if (texto === 'info') {
            const mensajeInfo = `🤖 *BOT FAMILIAR* 🤖\n\n📝 *Anotar:* _costo 20000_\n📅 *Mes:* _total mes_\n📊 *Resumen:* _resumen mes_\n👤 *Lo tuyo:* _mis gastos mes_\n📆 *Fechas:* _total desde DD/MM/AAAA hasta DD/MM/AAAA_\n💰 *Histórico:* _total historico_`;
            await responder(mensajeInfo);
        } else if (texto.startsWith('costo ')) {
            let numeroCrudo = texto.replace('costo', '').replace(/[.,\s]/g, '');
            let soloNumeros = numeroCrudo.match(/^\d+/); 
            if (soloNumeros) {
                let monto = parseInt(soloNumeros[0]);
                const { error } = await supabase.from('gastos').insert([{ telefono: telefonoRemitente, monto: monto }]);
                if (error) await responder('❌ Hubo un error en la BD.');
                else await responder(`Anotado: $${monto} ✅`);
            }
        } else if (texto === 'total mes') {
            const f = new Date();
            const p = new Date(f.getFullYear(), Math.max(0, f.getMonth()), 1).toISOString();
            const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', p);
            if (!error) await responder(`📅 Gasto total mes: *$${data.reduce((a, b) => a + b.monto, 0)}*`);
        } else if (texto === 'mis gastos mes') {
            const f = new Date();
            const p = new Date(f.getFullYear(), Math.max(0, f.getMonth()), 1).toISOString();
            const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', p).eq('telefono', telefonoRemitente);
            if (!error) await responder(`👤 Vos gastaste: *$${data.reduce((a, b) => a + b.monto, 0)}*`);
        } else if (texto === 'resumen mes') {
            const f = new Date();
            const p = new Date(f.getFullYear(), Math.max(0, f.getMonth()), 1).toISOString();
            const { data, error } = await supabase.from('gastos').select('telefono, monto').gte('fecha', p);
            if (!error && data.length > 0) {
                const res = data.reduce((acc, g) => { acc[g.telefono] = (acc[g.telefono] || 0) + g.monto; return acc; }, {});
                let mRes = `📊 *RESUMEN DEL MES* 📊\n\n`;
                for (const [t, tot] of Object.entries(res)) mRes += `📱 ${t.split('@')[0]}: *$${tot}*\n`;
                await responder(mRes);
            }
        } else if (texto.startsWith('total desde ') && texto.includes(' hasta ')) {
            const match = texto.match(/total desde (\d{1,2}\/\d{1,2}\/\d{4}) hasta (\d{1,2}\/\d{1,2}\/\d{4})/);
            if (match) {
                const fI = formatearFecha(match[1]);
                const fF = formatearFecha(match[2]);
                if (fI && fF) {
                    const fFObj = new Date(fF); fFObj.setDate(fFObj.getDate() + 1);
                    const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', `${fI}T00:00:00.000Z`).lte('fecha', fFObj.toISOString());
                    if (!error) await responder(`📆 Gasto entre ${match[1]} y ${match[2]}: *$${data.reduce((a, b) => a + b.monto, 0)}*`);
                }
            }
        } else if (texto === 'total historico') {
            const { data, error } = await supabase.from('gastos').select('monto');
            if (!error) await responder(`💸 Deuda histórica: *$${data.reduce((a, b) => a + b.monto, 0)}*`);
        }
    });
}

const port = process.env.PORT || 3000;
http.createServer((req, res) => { res.end("Bot de gastos activo"); }).listen(port);
iniciarBot();