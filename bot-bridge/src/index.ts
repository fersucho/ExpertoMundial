import { Client, LocalAuth } from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import axios from 'axios';
import * as dotenv from 'dotenv';
import * as path from 'path';

// Cargar variables de entorno
dotenv.config();

const FUNCTIONS_URL = process.env.FIREBASE_FUNCTIONS_URL || 'http://127.0.0.1:5001/experto-mundial/us-central1';
const SECRET_TOKEN = process.env.BOT_SECRET_TOKEN;

if (!SECRET_TOKEN) {
    console.error('❌ ERROR CRÍTICO: La variable de entorno BOT_SECRET_TOKEN no está definida en el archivo .env.');
    process.exit(1);
}

// Función helper para limpiar los IDs de usuario de WhatsApp de sufijos multi-dispositivo y conservar el dominio original (@c.us o @lid)
function cleanUserId(rawId: string): string {
    if (!rawId) return '';
    const parts = rawId.split('@');
    const user = parts[0].split(':')[0];
    const domain = parts[1] || 'c.us';
    return `${user}@${domain}`;
}

// Variables globales para la identidad del bot y administración
let botUserId = '';
const registeredLIDs = new Set<string>();

console.log('🤖 Inicializando puente de WhatsApp...');
console.log(`📡 URL de Cloud Functions: ${FUNCTIONS_URL}`);

// Configurar cliente de WhatsApp con persistencia de sesión local y parches de compatibilidad
const client = new Client({
    authStrategy: new LocalAuth({
        dataPath: path.join(__dirname, '../.wwebjs_auth')
    }),
    puppeteer: {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
    }
});

// Mostrar código QR en consola para iniciar sesión
client.on('qr', (qr) => {
    console.log('⚡ Escanea el siguiente código QR con tu WhatsApp:');
    qrcode.generate(qr, { small: true });
});

// Monitorear pantalla de carga
client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Cargando WhatsApp Web: ${percent}% - ${message}`);
});

// Capturar fallos de autenticación
client.on('auth_failure', (msg) => {
    console.error('❌ Error de autenticación:', msg);
});

// Confirmación de inicio de sesión y auto-registro de Administrador
client.on('ready', async () => {
    console.log('✅ ¡El bot de WhatsApp está LISTO y conectado!');
    
    try {
        botUserId = client.info.wid.user + '@c.us';
        const botSerializedId = cleanUserId(client.info.wid._serialized);
        
        // Registrar en el set local de LIDs autorizados
        registeredLIDs.add(botUserId);
        registeredLIDs.add(botSerializedId);
        
        console.log(`👑 Registrando al bot (${botUserId}) como Administrador en Firestore...`);
        
        // Cabecera de autorización para las Cloud Functions
        const headers = {
            'Authorization': `Bearer ${SECRET_TOKEN}`,
            'Content-Type': 'application/json'
        };
        
        const response = await axios.post(`${FUNCTIONS_URL}/registrarUsuario`, {
            userId: botUserId,
            name: 'Admin',
            isAdminCreation: true
        }, { headers });
        
        console.log(`👑 Admin Autoregistro: ${response.data.message}`);

        if (botSerializedId && botSerializedId !== botUserId) {
            console.log(`👑 Registrando identificador LID del bot (${botSerializedId}) como Administrador en Firestore...`);
            const responseAlt = await axios.post(`${FUNCTIONS_URL}/registrarUsuario`, {
                userId: botSerializedId,
                name: 'Admin (LID)',
                isAdminCreation: true
            }, { headers });
            console.log(`👑 Admin Autoregistro (LID): ${responseAlt.data.message}`);
        }
    } catch (error: any) {
        console.error('❌ Error en el auto-registro del administrador:', error.message);
    }
});

// Almacena los estados de los usuarios para conversaciones interactivas (ej: esperando nickname)
const userStates = new Map<string, { state: string; timestamp: number; groupId?: string | null }>();
const STATE_TIMEOUT = 2 * 60 * 1000; // 2 minutos de expiración

// Escuchar todos los mensajes creados (recibidos y auto-mensajes enviados desde esta cuenta)
client.on('message_create', async (msg) => {
    const text = msg.body.trim();
    if (text === '') return;

    // El ID del usuario que envía el mensaje (limpiamos sufijos de multi-dispositivo como :1, :2, etc. para evitar inconsistencias en la base de datos)
    const rawUserId = msg.author || msg.from;
    const userId = cleanUserId(rawUserId);

    // Cabecera de autorización para las Cloud Functions
    const headers = {
        'Authorization': `Bearer ${SECRET_TOKEN}`,
        'Content-Type': 'application/json'
    };

    // 1. Verificar si el usuario tiene un estado activo (ej: esperando nickname)
    const userState = userStates.get(userId);
    if (userState) {
        // Evitar bucle de retroalimentación: ignoramos la propia pregunta del bot si es el usuario anfitrión
        if (msg.fromMe && text.startsWith('👤 *REGISTRO DE NICKNAME*')) {
            return;
        }

        // Verificar expiración del estado
        if (Date.now() - userState.timestamp < STATE_TIMEOUT) {
            if (userState.state === 'AWAITING_NICKNAME') {
                userStates.delete(userId); // Limpiamos el estado de inmediato
                
                try {
                    const response = await axios.post(`${FUNCTIONS_URL}/registrarUsuario`, {
                        userId,
                        name: text, // El texto completo enviado es su nickname
                        groupId: userState.groupId // Si se registró en un grupo, lo unimos
                    }, { headers });
                    await msg.reply(response.data.message);
                } catch (error: any) {
                    console.error('❌ Error al registrar nickname:', error.message);
                    await msg.reply('❌ Hubo un error al registrar tu nickname. Por favor, intenta de nuevo usando E.');
                }
                return;
            }
        } else {
            // Estado expirado, lo removemos
            userStates.delete(userId);
        }
    }

    // 2. Determinar si el mensaje es un comando, una letra del menú principal o predicciones rápidas
    let command = '';
    let args: string[] = [];
    let multiPredictions: Array<{ matchId: string; predictA: number; predictB: number }> = [];

    // Dividimos por líneas y limpiamos espacios vacíos
    const lines = text.split('\n').map(line => line.trim()).filter(line => line !== '');
    const quickPredictionRegex = /^(\d+)\s*:\s*(\d+)-(\d+)$/;
    const allLinesArePredictions = lines.length > 0 && lines.every(line => quickPredictionRegex.test(line));

    if (allLinesArePredictions) {
        command = '!pronosticomulti';
        multiPredictions = lines.map(line => {
            const match = line.match(quickPredictionRegex)!;
            return {
                matchId: match[1],
                predictA: parseInt(match[2], 10),
                predictB: parseInt(match[3], 10)
            };
        });
    } else if (text.startsWith('!')) {
        const parts = text.split(/\s+/);
        command = parts[0].toLowerCase();
        args = parts.slice(1);
    } else {
        // Si no inicia con '!', verificamos si coincide exactamente con una letra del menú o 'menu'
        const lowerText = text.toLowerCase();
        if (['a', 'b', 'c', 'd', 'e', 'f', 'menu'].includes(lowerText)) {
            command = '!' + lowerText;
        }
    }

    // Si no es un comando ni una opción de menú válida, ignoramos el mensaje (para evitar spam en chats)
    if (command === '') return;

    const chat = await msg.getChat();
    const groupId = chat.isGroup ? chat.id._serialized : null;
    
    // Auto-registro dinámico para el identificador LID alternativo del administrador
    // Si el mensaje es enviado por el propio usuario (fromMe) en un chat privado y no está registrado aún
    if (msg.fromMe && !chat.isGroup && userId !== botUserId && !registeredLIDs.has(userId)) {
        console.log(`👑 Actividad del dueño detectada en chat privado. Auto-registrando LID ${userId} como Admin...`);
        try {
            await axios.post(`${FUNCTIONS_URL}/registrarUsuario`, {
                userId,
                name: 'Admin (LID Auto)',
                isAdminCreation: true
            }, { headers });
            registeredLIDs.add(userId);
            console.log(`👑 LID ${userId} auto-registrado en Firestore con éxito.`);
        } catch (err: any) {
            console.error(`❌ Error al auto-registrar LID de administrador:`, err.message);
        }
    }
    
    // Obtener el nombre del remitente registrado en su WhatsApp de forma segura manejando errores de deviceWid
    let senderPushName = 'Usuario';
    try {
        const contact = await msg.getContact();
        senderPushName = contact.pushname || 'Usuario';
    } catch (err) {
        try {
            const contact = await client.getContactById(userId);
            senderPushName = contact.pushname || 'Usuario';
        } catch (innerErr) {
            console.error('⚠️ Error al obtener contacto limpio:', innerErr);
        }
    }

    // 3. Aplicar Restricciones de Canal de Chat (Grupo vs Privado)
    const adminCommands = ['!crearpartido', '!resultado'];
    const gameCommands = ['!menu', '!a', '!b', '!c', '!d', '!e', '!f', '!resultados', '!pronostico', '!pronosticomulti', '!registro', '!mispronosticos', '!ranking', '!tabla', '!reglas'];

    if (adminCommands.includes(command)) {
        if (chat.isGroup) {
            await msg.reply('⚠️ Los comandos de administración solo se pueden usar en chat privado directo con el bot.');
            return;
        }
    }

    if (gameCommands.includes(command)) {
        if (!chat.isGroup) {
            await msg.reply('⚠️ Este comando solo se puede utilizar dentro de un grupo de WhatsApp.');
            return;
        }
    }

    console.log(`💬 Comando recibido: "${command}" de ${senderPushName} (${userId}) en el chat ${chat.name}`);

    try {
        switch (command) {
            case '!menu': {
                const menuText = 
                    `🏆 *EXPERTO MUNDIAL - MENÚ PRINCIPAL* 🏆\n` +
                    `──────────────────\n` +
                    `Por favor, escribe únicamente la *letra* de la opción que deseas realizar:\n\n` +
                    `🇦 *Ver partidos disponibles*\n` +
                    `🇧 *Ver mis pronósticos*\n` +
                    `🇨 *Ver la tabla de posiciones*\n` +
                    `🇩 *Ver reglas del juego*\n` +
                    `🇪 *Registrarme / Cambiar nickname*\n` +
                    `🇫 *Ver resultados de partidos*\n\n` +
                    `──────────────────\n` +
                    `_Ejemplo: Escribe la letra *A* para ver los partidos y comenzar a jugar._`;
                await msg.reply(menuText);
                break;
            }

            case '!a':
            case '!partidos': {
                const response = await axios.get(`${FUNCTIONS_URL}/obtenerPartidos`, { headers });
                await msg.reply(response.data.message);
                break;
            }

            case '!b':
            case '!mispronosticos': {
                const response = await axios.post(`${FUNCTIONS_URL}/obtenerMisPronosticos`, {
                    userId,
                    groupId
                }, { headers });
                await msg.reply(response.data.message);
                break;
            }

            case '!c':
            case '!ranking':
            case '!tabla': {
                const response = await axios.get(`${FUNCTIONS_URL}/obtenerRanking?groupId=${groupId}`, { headers });
                await msg.reply(response.data.message);
                break;
            }

            case '!d':
            case '!reglas': {
                const rulesText = 
                    `🏆 *REGLAS DE EXPERTO MUNDIAL* 🏆\n` +
                    `──────────────────\n` +
                    `• *Acierto Exacto (Marcador exacto):* 3 puntos.\n` +
                    `  _Ej: Pronosticas 2-1 y el partido queda 2-1._\n\n` +
                    `• *Acierto de Ganador o Empate:* 1 punto.\n` +
                    `  _Ej: Pronosticas 2-1 (gana local) y queda 1-0. O pronosticas 1-1 y queda 2-2._\n\n` +
                    `• *Fallo Total:* 0 puntos.\n` +
                    `──────────────────\n` +
                    `_¡Los puntos se calculan automáticamente cuando el administrador carga el resultado final!_`;
                await msg.reply(rulesText);
                break;
            }

            case '!e': {
                userStates.set(userId, { state: 'AWAITING_NICKNAME', timestamp: Date.now(), groupId });
                const pushName = senderPushName !== 'Usuario' ? ` *${senderPushName}*` : '';
                await msg.reply(`👤 *REGISTRO DE NICKNAME* ⚽\nHola${pushName}, por favor responde a este mensaje escribiendo el *nickname* que deseas usar en el juego:`);
                break;
            }

            case '!f':
            case '!resultados': {
                const response = await axios.get(`${FUNCTIONS_URL}/obtenerResultados`, { headers });
                await msg.reply(response.data.message);
                break;
            }

            case '!pronosticomulti': {
                console.log(`🔮 Procesando ${multiPredictions.length} pronósticos de ${senderPushName} (${userId})`);
                
                const promises = multiPredictions.map(async (pred) => {
                    try {
                        const response = await axios.post(`${FUNCTIONS_URL}/pronosticar`, {
                            userId,
                            matchId: pred.matchId,
                            predictA: pred.predictA,
                            predictB: pred.predictB,
                            groupId
                        }, { headers });
                        
                        const msgMatch = response.data.message.match(/👉\s*\*(.+?)\*/);
                        const matchDetails = msgMatch ? msgMatch[1] : `ID ${pred.matchId}: ${pred.predictA} - ${pred.predictB}`;
                        return `• ${matchDetails} ✅ Guardado`;
                    } catch (error: any) {
                        let errMsg = 'Error de conexión';
                        if (error.response && error.response.data && error.response.data.message) {
                            errMsg = error.response.data.message;
                        }
                        const cleanErr = errMsg.replace(/^[⚠️❌\s]+/, '');
                        return `• ID ${pred.matchId} (${pred.predictA}-${pred.predictB}): ⚠️ ${cleanErr}`;
                    }
                });
                
                const responseLines = await Promise.all(promises);
                
                const summaryText = 
                    `🔮 *PRONÓSTICOS PROCESADOS* 🔮\n` +
                    `──────────────────\n` +
                    `👤 *${senderPushName}*\n\n` +
                    responseLines.join('\n') + `\n\n` +
                    `──────────────────\n` +
                    `_Usa la letra *B* para ver tus pronósticos activos._`;
                    
                await msg.reply(summaryText);
                break;
            }

            case '!registro': {
                const nickname = args.join(' ');
                if (!nickname) {
                    await msg.reply('⚠️ Debes indicar tu nickname. Ejemplo: `!registro ElDiego10` o escribe la letra *E* para registrarte de forma interactiva.');
                    break;
                }
                const response = await axios.post(`${FUNCTIONS_URL}/registrarUsuario`, {
                    userId,
                    name: nickname,
                    groupId
                }, { headers });
                await msg.reply(response.data.message);
                break;
            }

            case '!pronostico':
            case '!pronosticar': {
                if (args.length < 2) {
                    await msg.reply('⚠️ Formato incorrecto. Usa: `!pronostico [ID_PARTIDO] [GOLES_A]-[GOLES_B]`\nEjemplo: `!pronostico 1 2-1`');
                    break;
                }
                const matchId = args[0];
                const scoreStr = args[1]; // ej: "2-1" o "0-0"
                const scoreParts = scoreStr.split('-');

                if (scoreParts.length !== 2) {
                    await msg.reply('⚠️ Formato de resultado incorrecto. Debe ser `GolesA-GolesB` (ejemplo: `2-1`).');
                    break;
                }

                const predictA = parseInt(scoreParts[0], 10);
                const predictB = parseInt(scoreParts[1], 10);

                if (isNaN(predictA) || isNaN(predictB) || predictA < 0 || predictB < 0) {
                    await msg.reply('⚠️ Los goles deben ser números enteros válidos mayores o iguales a 0.');
                    break;
                }

                const response = await axios.post(`${FUNCTIONS_URL}/pronosticar`, {
                    userId,
                    matchId,
                    predictA,
                    predictB,
                    groupId
                }, { headers });
                await msg.reply(response.data.message);
                break;
            }

            // Comandos de Administración (solo válidos en privado)
            case '!crearpartido': {
                // Formato: !crearpartido EquipoA vs EquipoB YYYY-MM-DD HH:MM
                const textArgs = args.join(' ');
                const matchRegex = /(.+?)\s+vs\s+(.+?)\s+(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})/;
                const matchFound = textArgs.match(matchRegex);

                if (!matchFound) {
                    await msg.reply('⚠️ Formato incorrecto de administrador. Usa:\n`!crearpartido [EquipoA] vs [EquipoB] [YYYY-MM-DD HH:MM]`\nEjemplo: `!crearpartido Argentina vs Brasil 2026-06-15 15:00`');
                    break;
                }

                const [, teamA, teamB, dateStr] = matchFound;
                const response = await axios.post(`${FUNCTIONS_URL}/crearPartido`, {
                    userId,
                    teamA: teamA.trim(),
                    teamB: teamB.trim(),
                    dateStr: dateStr.trim()
                }, { headers });
                await msg.reply(response.data.message);
                break;
            }

            case '!resultado': {
                // Formato: !resultado [id_partido] [golesA]-[golesB]
                if (args.length < 2) {
                    await msg.reply('⚠️ Formato incorrecto de administrador. Usa:\n`!resultado [ID_PARTIDO] [GOLES_A]-[GOLES_B]`\nEjemplo: `!resultado 1 2-1`');
                    break;
                }
                const matchId = args[0];
                const scoreStr = args[1];
                const scoreParts = scoreStr.split('-');

                if (scoreParts.length !== 2) {
                    await msg.reply('⚠️ Formato de resultado incorrecto. Debe ser `GolesA-GolesB`.');
                    break;
                }

                const scoreA = parseInt(scoreParts[0], 10);
                const scoreB = parseInt(scoreParts[1], 10);

                if (isNaN(scoreA) || isNaN(scoreB)) {
                    await msg.reply('⚠️ Los goles deben ser números enteros válidos.');
                    break;
                }

                const response = await axios.post(`${FUNCTIONS_URL}/actualizarResultado`, {
                    userId,
                    matchId,
                    scoreA,
                    scoreB
                }, { headers });
                await msg.reply(response.data.message);
                break;
            }

            default: {
                // Solo respondemos si el mensaje del usuario inició explícitamente con '!'
                if (text.startsWith('!')) {
                    await msg.reply(`⚠️ El comando *${command}* no existe.\nEscribe *!menu* o la palabra *menu* para ver las opciones disponibles. ⚽`);
                }
                break;
            }
        }
    } catch (error: any) {
        console.error('❌ Error al procesar petición a Cloud Function:', error.message);
        if (error.response && error.response.data && error.response.data.message) {
            await msg.reply(`❌ Error: ${error.response.data.message}`);
        } else {
            await msg.reply('❌ Lo siento, hubo un problema interno en el servidor. Por favor, intenta de nuevo más tarde.');
        }
    }
});

// Inicializar el cliente de WhatsApp
client.initialize();
