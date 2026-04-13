const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();
const http = require('http'); // Importamos la librería para el servidor falso

// --- CONFIGURACIÓN DE SUPABASE SEGURA ---
const supabaseUrl = process.env.SUPABASE_URL; 
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
// ----------------------------------------

// Ponemos a Chrome a dieta extrema para que no consuma los 512MB de Render
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage', // Clave para servidores Linux con poca RAM
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // Forza a usar un solo proceso
            '--disable-gpu'
        ]
    }
});

const limpiarTexto = (texto) => {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
};

const formatearFecha = (fechaStr) => {
    const partes = fechaStr.split('/');
    if (partes.length !== 3) return null;
    return `${partes[2]}-${partes[1]}-${partes[0]}`;
};

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('¡Escaneá el QR rápido!');
});

client.on('ready', () => {
    console.log('¡Bot conectado y base de datos lista!');
});

client.on('message_create', async (message) => {
    const texto = limpiarTexto(message.body);

    if (texto === 'info') {
        const mensajeInfo = `🤖 *BOT FAMILIAR DE GASTOS* 🤖\n\n` +
            `📝 *Anotar un gasto:*\nEscribí "costo" seguido del número. Ej: _costo 20000 pan_\n\n` +
            `📅 *Ver total del mes:*\nEscribí: _total mes_\n\n` +
            `📊 *Ver quién gastó qué este mes:*\nEscribí: _resumen mes_\n\n` +
            `👤 *Ver solo tus gastos del mes:*\nEscribí: _mis gastos mes_\n\n` +
            `📆 *Ver por fechas:*\nEscribí: _total desde 01/04/2024 hasta 15/04/2024_\n\n` +
            `💰 *Ver total histórico:*\nEscribí: _total historico_`;
        await message.reply(mensajeInfo);
    }

    else if (texto.startsWith('costo ')) {
        let numeroCrudo = texto.replace('costo', '').replace(/[.,\s]/g, '');
        let soloNumeros = numeroCrudo.match(/^\d+/); 
        
        if (soloNumeros) {
            let monto = parseInt(soloNumeros[0]);
            const { error } = await supabase.from('gastos').insert([{ telefono: message.from, monto: monto }]);

            if (error) {
                await message.reply('❌ Hubo un error al guardar en la base de datos.');
            } else {
                await message.reply(`Anotado: $${monto} ✅`);
            }
        } else {
            await message.reply(`Mmm, no entendí. Escribí por ejemplo: costo 20000`);
        }
    }

    else if (texto === 'total mes') {
        const fechaActual = new Date();
        const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();
        const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', primerDiaDelMes);

        if (!error) {
            const totalMes = data.reduce((acc, gasto) => acc + gasto.monto, 0);
            await message.reply(`📅 Gasto total de este mes: *$${totalMes}*`);
        }
    }

    else if (texto === 'mis gastos mes') {
        const fechaActual = new Date();
        const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();
        const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', primerDiaDelMes).eq('telefono', message.from);

        if (!error) {
            const totalMio = data.reduce((acc, gasto) => acc + gasto.monto, 0);
            await message.reply(`👤 Este mes vos sacaste fiado: *$${totalMio}*`);
        }
    }

    else if (texto === 'resumen mes') {
        const fechaActual = new Date();
        const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();
        const { data, error } = await supabase.from('gastos').select('telefono, monto').gte('fecha', primerDiaDelMes);

        if (!error && data.length > 0) {
            const resumen = data.reduce((acc, gasto) => {
                acc[gasto.telefono] = (acc[gasto.telefono] || 0) + gasto.monto;
                return acc;
            }, {});

            let mensajeResumen = `📊 *RESUMEN DEL MES POR PERSONA* 📊\n\n`;
            for (const [telefono, total] of Object.entries(resumen)) {
                let numeroLimpio = telefono.split('@')[0];
                mensajeResumen += `📱 ${numeroLimpio}: *$${total}*\n`;
            }
            await message.reply(mensajeResumen);
        } else if (data && data.length === 0) {
            await message.reply('Todavía no hay gastos este mes.');
        }
    }

    else if (texto.startsWith('total desde ') && texto.includes(' hasta ')) {
        const regexFechas = /total desde (\d{1,2}\/\d{1,2}\/\d{4}) hasta (\d{1,2}\/\d{1,2}\/\d{4})/;
        const match = texto.match(regexFechas);

        if (match) {
            const fechaInicio = formatearFecha(match[1]);
            const fechaFin = formatearFecha(match[2]);

            if (fechaInicio && fechaFin) {
                const fechaFinObjeto = new Date(fechaFin);
                fechaFinObjeto.setDate(fechaFinObjeto.getDate() + 1);
                const fechaFinReal = fechaFinObjeto.toISOString();

                const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', `${fechaInicio}T00:00:00.000Z`).lte('fecha', fechaFinReal);

                if (!error) {
                    const totalPeriodo = data.reduce((acc, gasto) => acc + gasto.monto, 0);
                    await message.reply(`📆 Gasto entre ${match[1]} y ${match[2]}: *$${totalPeriodo}*`);
                }
            }
        }
    }

    else if (texto === 'total historico') {
        const { data, error } = await supabase.from('gastos').select('monto');
        if (!error) {
            const total = data.reduce((acc, gasto) => acc + gasto.monto, 0);
            await message.reply(`💸 Deuda total histórica acumulada: *$${total}*`);
        }
    }
});

// --- SERVIDOR WEB FALSO PARA RENDER ---
const port = process.env.PORT || 3000;
http.createServer((req, res) => {
    res.write("El bot familiar funciona de 10");
    res.end();
}).listen(port, () => {
    console.log(`Servidor de coartada escuchando en el puerto ${port}`);
});
// --------------------------------------

client.initialize();