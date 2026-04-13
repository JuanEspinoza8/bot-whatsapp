const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { createClient } = require('@supabase/supabase-js');

// --- CONFIGURACIÓN DE SUPABASE ---
// REEMPLAZÁ ESTOS DATOS CON LOS TUYOS
const supabaseUrl = process.env.SUPABASE_URL; 
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);
// ---------------------------------

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Función para sacar acentos y pasar a minúsculas
const limpiarTexto = (texto) => {
    return texto.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
};

// Función para convertir fecha de DD/MM/AAAA a formato que entienda la BD (AAAA-MM-DD)
const formatearFecha = (fechaStr) => {
    const partes = fechaStr.split('/');
    if (partes.length !== 3) return null;
    return `${partes[2]}-${partes[1]}-${partes[0]}`;
};

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Escaneá el QR...');
});

client.on('ready', () => {
    console.log('¡Bot conectado, con funciones extra y base de datos lista!');
});

client.on('message_create', async (message) => {
    // Aplicamos la limpieza de acentos y mayúsculas
    const texto = limpiarTexto(message.body);

    // 1. COMANDO: INFO
    if (texto === 'info') {
        const mensajeInfo = `🤖 *BOT FAMILIAR DE GASTOS* 🤖\n\n` +
            `Acá tenés los comandos que podés usar:\n\n` +
            `📝 *Anotar un gasto:*\nEscribí "costo" seguido del número. Ej: _costo 20000 pan_\n\n` +
            `📅 *Ver total del mes:*\nEscribí: _total mes_\n\n` +
            `📊 *Ver quién gastó qué este mes:*\nEscribí: _resumen mes_\n\n` +
            `👤 *Ver solo tus gastos del mes:*\nEscribí: _mis gastos mes_\n\n` +
            `📆 *Ver por fechas:*\nEscribí: _total desde 01/04/2024 hasta 15/04/2024_\n\n` +
            `💰 *Ver total histórico:*\nEscribí: _total historico_`;
        
        await message.reply(mensajeInfo);
    }

    // 2. COMANDO: COSTO
    else if (texto.startsWith('costo ')) {
        let numeroCrudo = texto.replace('costo', '').replace(/[.,\s]/g, '');
        // Extraemos solo los números iniciales por si escriben "costo 5000 de pan"
        let soloNumeros = numeroCrudo.match(/^\d+/); 
        
        if (soloNumeros) {
            let monto = parseInt(soloNumeros[0]);
            
            const { error } = await supabase
                .from('gastos')
                .insert([{ telefono: message.from, monto: monto }]);

            if (error) {
                await message.reply('❌ Hubo un error al guardar en la base de datos.');
            } else {
                await message.reply(`Anotado: $${monto} ✅`);
            }
        } else {
            await message.reply(`Mmm, no entendí. Escribí por ejemplo: costo 20000`);
        }
    }

    // 3. COMANDO: TOTAL MES
    else if (texto === 'total mes') {
        const fechaActual = new Date();
        const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();

        const { data, error } = await supabase.from('gastos').select('monto').gte('fecha', primerDiaDelMes);

        if (!error) {
            const totalMes = data.reduce((acc, gasto) => acc + gasto.monto, 0);
            await message.reply(`📅 Gasto total de este mes: *$${totalMes}*`);
        }
    }

    // 4. COMANDO: MIS GASTOS MES (Solo la persona que lo pide)
    else if (texto === 'mis gastos mes') {
        const fechaActual = new Date();
        const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();

        const { data, error } = await supabase
            .from('gastos')
            .select('monto')
            .gte('fecha', primerDiaDelMes)
            .eq('telefono', message.from); // Filtra por el celular que manda el mensaje

        if (!error) {
            const totalMio = data.reduce((acc, gasto) => acc + gasto.monto, 0);
            await message.reply(`👤 Este mes vos sacaste fiado: *$${totalMio}*`);
        }
    }

    // 5. COMANDO: RESUMEN MES (Desglose por persona)
    else if (texto === 'resumen mes') {
        const fechaActual = new Date();
        const primerDiaDelMes = new Date(fechaActual.getFullYear(), Math.max(0, fechaActual.getMonth()), 1).toISOString();

        const { data, error } = await supabase.from('gastos').select('telefono, monto').gte('fecha', primerDiaDelMes);

        if (!error && data.length > 0) {
            // Agrupamos los montos por número de teléfono usando JS puro
            const resumen = data.reduce((acc, gasto) => {
                acc[gasto.telefono] = (acc[gasto.telefono] || 0) + gasto.monto;
                return acc;
            }, {});

            let mensajeResumen = `📊 *RESUMEN DEL MES POR PERSONA* 📊\n\n`;
            for (const [telefono, total] of Object.entries(resumen)) {
                // Limpiamos el ID de WhatsApp para que se vea solo el número
                let numeroLimpio = telefono.split('@')[0];
                mensajeResumen += `📱 ${numeroLimpio}: *$${total}*\n`;
            }
            await message.reply(mensajeResumen);
        } else if (data && data.length === 0) {
            await message.reply('Todavía no hay gastos este mes.');
        }
    }

    // 6. COMANDO: TOTAL DESDE ... HASTA ...
    else if (texto.startsWith('total desde ') && texto.includes(' hasta ')) {
        // Expresión regular para sacar las fechas de la frase
        const regexFechas = /total desde (\d{1,2}\/\d{1,2}\/\d{4}) hasta (\d{1,2}\/\d{1,2}\/\d{4})/;
        const match = texto.match(regexFechas);

        if (match) {
            const fechaInicio = formatearFecha(match[1]);
            const fechaFin = formatearFecha(match[2]);

            if (fechaInicio && fechaFin) {
                // Le sumamos un día a la fecha final para que incluya todo ese día en la BD
                const fechaFinObjeto = new Date(fechaFin);
                fechaFinObjeto.setDate(fechaFinObjeto.getDate() + 1);
                const fechaFinReal = fechaFinObjeto.toISOString();

                const { data, error } = await supabase
                    .from('gastos')
                    .select('monto')
                    .gte('fecha', `${fechaInicio}T00:00:00.000Z`)
                    .lte('fecha', fechaFinReal); // lte = less than or equal

                if (!error) {
                    const totalPeriodo = data.reduce((acc, gasto) => acc + gasto.monto, 0);
                    await message.reply(`📆 Gasto entre ${match[1]} y ${match[2]}: *$${totalPeriodo}*`);
                } else {
                    await message.reply('❌ Hubo un error al calcular esas fechas.');
                }
            } else {
                await message.reply('Mmm, el formato de la fecha parece raro. Usá DD/MM/AAAA.');
            }
        }
    }

    // 7. COMANDO: TOTAL HISTÓRICO
    else if (texto === 'total historico') {
        const { data, error } = await supabase.from('gastos').select('monto');
        if (!error) {
            const total = data.reduce((acc, gasto) => acc + gasto.monto, 0);
            await message.reply(`💸 Deuda total histórica acumulada: *$${total}*`);
        }
    }
});

client.initialize();