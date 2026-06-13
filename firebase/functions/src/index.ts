import { onRequest } from 'firebase-functions/v2/https';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';

initializeApp();
const db = getFirestore();

const SECRET_TOKEN = process.env.BOT_SECRET_TOKEN;

// Función auxiliar para validar el token de autorización
function isAuthorized(req: any): boolean {
    if (!SECRET_TOKEN) {
        console.error('❌ ERROR: La variable de entorno BOT_SECRET_TOKEN no está configurada en la Cloud Function.');
        return false;
    }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return false;
    }
    const token = authHeader.split('Bearer ')[1];
    return token === SECRET_TOKEN;
}

// Helper para responder con error de autorización
function sendUnauthorized(res: any) {
    res.status(401).json({ message: 'No autorizado. Token incorrecto o ausente.' });
}

/**
 * 1. Registrar o actualizar un usuario
 */
export const registrarUsuario = onRequest({ invoker: 'public' }, async (req, res) => {
    if (!isAuthorized(req)) return sendUnauthorized(res);

    const { userId, name, isAdminCreation, groupId } = req.body;
    if (!userId || !name) {
        res.status(400).json({ message: 'Faltan parámetros: userId y name son obligatorios.' });
        return;
    }

    try {
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();

        let isAdmin = false;
        
        if (isAdminCreation) {
            // El bot fuerza la creación del administrador
            isAdmin = true;
        } else if (userDoc.exists) {
            // Conservar estado de admin anterior si ya existe
            isAdmin = userDoc.data()?.admin || false;
        }

        if (userDoc.exists) {
            await userRef.update({ name, admin: isAdmin });
        } else {
            await userRef.set({
                name,
                admin: isAdmin,
                registeredAt: FieldValue.serverTimestamp()
            });
        }

        // Si se incluye groupId, también lo unimos a la quiniela de ese grupo
        if (groupId) {
            const memberRef = db.collection('groups').doc(groupId).collection('members').doc(userId);
            const memberDoc = await memberRef.get();

            if (!memberDoc.exists) {
                await memberRef.set({
                    name,
                    points: 0,
                    exactMatches: 0
                });
            } else {
                await memberRef.update({ name });
            }
        }

        if (isAdminCreation) {
            res.json({
                message: `👑 ¡Sistema Inicializado! Has sido registrado como el **Administrador** global del juego.`
            });
        } else {
            res.json({
                message: `🎉 ¡Hola, *${name}*! Te has registrado exitosamente. Escribe *A* para ver los partidos y comenzar a jugar. ⚽`
            });
        }
    } catch (error: any) {
        res.status(500).json({ message: `Error al registrar usuario: ${error.message}` });
    }
});

/**
 * 2. Crear partido (Admin)
 */
export const crearPartido = onRequest({ invoker: 'public' }, async (req, res) => {
    if (!isAuthorized(req)) return sendUnauthorized(res);

    const { userId, teamA, teamB, dateStr } = req.body;
    if (!userId || !teamA || !teamB || !dateStr) {
        res.status(400).json({ message: 'Faltan parámetros: userId, teamA, teamB y dateStr son obligatorios.' });
        return;
    }

    try {
        // Validar rol de administrador
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || !userDoc.data()?.admin) {
            res.status(403).json({ message: '⚠️ No tienes permisos de administrador para realizar esta acción.' });
            return;
        }

        // Parsear fecha "YYYY-MM-DD HH:MM"
        const dateParts = dateStr.split(' ');
        if (dateParts.length !== 2) {
            res.status(400).json({ message: 'Formato de fecha inválido. Debe ser YYYY-MM-DD HH:MM.' });
            return;
        }

        const [ymd, hm] = dateParts;
        const [year, month, day] = ymd.split('-').map(Number);
        const [hour, minute] = hm.split(':').map(Number);

        // Construir string ISO 8601 con la zona horaria de Quito (UTC-5 / -05:00) para evitar que se interprete en UTC
        const monthPad = String(month).padStart(2, '0');
        const dayPad = String(day).padStart(2, '0');
        const hourPad = String(hour).padStart(2, '0');
        const minutePad = String(minute).padStart(2, '0');
        const isoString = `${year}-${monthPad}-${dayPad}T${hourPad}:${minutePad}:00-05:00`;
        
        const matchDate = new Date(isoString);

        if (isNaN(matchDate.getTime())) {
            res.status(400).json({ message: 'Fecha u hora no válidas.' });
            return;
        }

        // Obtener el siguiente ID secuencial
        const snapshot = await db.collection('matches').get();
        const nextId = String(snapshot.size + 1);

        await db.collection('matches').doc(nextId).set({
            teamA,
            teamB,
            date: Timestamp.fromDate(matchDate),
            status: 'pending',
            scoreA: null,
            scoreB: null
        });

        res.json({
            message: `📅 ¡Partido creado con éxito!\n👉 *ID: ${nextId}*\n⚽ *${teamA} vs ${teamB}*\n⏰ Límite (Quito): ${dateStr}`
        });
    } catch (error: any) {
        res.status(500).json({ message: `Error al crear partido: ${error.message}` });
    }
});

/**
 * 3. Obtener partidos disponibles
 */
export const obtenerPartidos = onRequest({ invoker: 'public' }, async (req, res) => {
    if (!isAuthorized(req)) return sendUnauthorized(res);

    try {
        const snapshot = await db.collection('matches').orderBy('date', 'asc').get();
        
        // Filtrar en memoria solo los partidos pendientes
        const pendingMatches: any[] = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.status === 'pending') {
                pendingMatches.push({ id: doc.id, ...data });
            }
        });

        if (pendingMatches.length === 0) {
            res.json({ message: '📅 No hay partidos pendientes para pronosticar en este momento.' });
            return;
        }

        let responseText = '⚽ *PARTIDOS DISPONIBLES* ⚽\n──────────────────\n';
        
        pendingMatches.forEach(match => {
            const date = match.date.toDate();
            
            // Formatear fecha a español de Ecuador (hora de Quito)
            const formattedDate = date.toLocaleString('es-EC', {
                timeZone: 'America/Guayaquil',
                day: '2-digit',
                month: '2-digit',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                hour12: false
            });

            responseText += `👉 *ID: ${match.id}* | *${match.teamA} vs ${match.teamB}*\n`;
            responseText += `📅 Límite: ${formattedDate}\n\n`;
        });

        responseText += 
            '──────────────────\n' +
            '🔮 *CÓMO PRONOSTICAR:*\n' +
            'Escribe tu pronóstico de esta forma:\n' +
            '👉 *[ID]: [Marcador]*\n' +
            '_Ejemplo: *1: 2-1* (o también *!pronostico 1 2-1*)_';
        res.json({ message: responseText });
    } catch (error: any) {
        res.status(500).json({ message: `Error al obtener partidos: ${error.message}` });
    }
});

/**
 * 4. Registrar pronóstico
 */
export const pronosticar = onRequest({ invoker: 'public' }, async (req, res) => {
    if (!isAuthorized(req)) return sendUnauthorized(res);

    const { userId, matchId, predictA, predictB, groupId } = req.body;
    if (!userId || !matchId || predictA === undefined || predictB === undefined || !groupId) {
        res.status(400).json({ message: 'Faltan parámetros requeridos.' });
        return;
    }

    try {
        // Verificar si el usuario existe globalmente
        const userRef = db.collection('users').doc(userId);
        const userDoc = await userRef.get();
        if (!userDoc.exists) {
            res.json({ message: '⚠️ No estás registrado en el juego. Escribe *E* para registrar tu nickname primero.' });
            return;
        }
        const user = userDoc.data()!;

        // Verificar si el partido existe
        const matchRef = db.collection('matches').doc(matchId);
        const matchDoc = await matchRef.get();
        if (!matchDoc.exists) {
            res.json({ message: `⚠️ El partido con ID *${matchId}* no existe.` });
            return;
        }

        const match = matchDoc.data()!;
        if (match.status !== 'pending') {
            res.json({ message: `⚠️ No puedes pronosticar este partido. Ya se encuentra en estado: *${match.status}*.` });
            return;
        }

        // Verificar si ya venció el tiempo límite
        const limitTime = match.date.toDate().getTime();
        const currentTime = Date.now();
        if (currentTime > limitTime) {
            res.json({ message: `⚠️ ¡Tiempo agotado! El límite para pronosticar era hasta la hora programada del partido.` });
            return;
        }

        // Auto-unión al grupo: Verificar si el usuario ya es miembro de la quiniela de este grupo
        const memberRef = db.collection('groups').doc(groupId).collection('members').doc(userId);
        const memberDoc = await memberRef.get();
        if (!memberDoc.exists) {
            await memberRef.set({
                name: user.name,
                points: 0,
                exactMatches: 0
            });
        }

        // Guardar o actualizar la predicción en el ámbito del grupo
        const predictionId = `${userId}_${matchId}_${groupId}`;
        const predictionRef = db.collection('predictions').doc(predictionId);

        await predictionRef.set({
            userId,
            userName: user.name,
            matchId,
            groupId,
            predictA,
            predictB,
            pointsEarned: 0,
            timestamp: FieldValue.serverTimestamp()
        });

        res.json({
            message: `✅ ¡Pronóstico guardado!\n🔮 *${user.name}* predijo para este grupo:\n👉 *${match.teamA} ${predictA} - ${predictB} ${match.teamB}*`
        });
    } catch (error: any) {
        res.status(500).json({ message: `Error al registrar pronóstico: ${error.message}` });
    }
});

/**
 * 5. Obtener los pronósticos de un usuario específico en un grupo
 */
export const obtenerMisPronosticos = onRequest({ invoker: 'public' }, async (req, res) => {
    if (!isAuthorized(req)) return sendUnauthorized(res);

    const { userId, groupId } = req.body;
    if (!userId || !groupId) {
        res.status(400).json({ message: 'userId y groupId son obligatorios.' });
        return;
    }

    try {
        // Verificar si el usuario existe y está registrado en este grupo
        const memberDoc = await db.collection('groups').doc(groupId).collection('members').doc(userId).get();
        if (!memberDoc.exists) {
            res.json({ message: '⚠️ Aún no estás registrado en la quiniela de este grupo. Envía un pronóstico o escribe *E* para unirte.' });
            return;
        }

        const userName = memberDoc.data()!.name;

        // Cargar todos los partidos para el join en memoria
        const matchesSnapshot = await db.collection('matches').get();
        const matchesMap: { [key: string]: any } = {};
        matchesSnapshot.forEach(doc => {
            matchesMap[doc.id] = doc.data();
        });

        // Buscar predicciones del usuario en este grupo
        const predSnapshot = await db.collection('predictions')
            .where('userId', '==', userId)
            .where('groupId', '==', groupId)
            .get();

        if (predSnapshot.empty) {
            res.json({ message: `🔮 *${userName}*, aún no has enviado ningún pronóstico en este grupo. Escribe *A* para ver la lista.` });
            return;
        }

        let responseText = `🔮 *PRONÓSTICOS DE ${userName.toUpperCase()}* 🔮\n──────────────────\n`;

        predSnapshot.forEach(doc => {
            const pred = doc.data();
            const match = matchesMap[pred.matchId];
            if (match) {
                responseText += `⚽ *${match.teamA} vs ${match.teamB}*\n`;
                responseText += `   Tu predicción: *${pred.predictA} - ${pred.predictB}*\n`;
                
                if (match.status === 'finished') {
                    responseText += `   Resultado real: *${match.scoreA} - ${match.scoreB}* (${pred.pointsEarned} pts)\n\n`;
                } else {
                    responseText += `   Resultado real: ⏳ Pendiente\n\n`;
                }
            }
        });

        responseText += '──────────────────';
        res.json({ message: responseText });
    } catch (error: any) {
        res.status(500).json({ message: `Error al obtener pronósticos: ${error.message}` });
    }
});

/**
 * 6. Obtener tabla de posiciones / ranking de un grupo
 */
export const obtenerRanking = onRequest({ invoker: 'public' }, async (req, res) => {
    if (!isAuthorized(req)) return sendUnauthorized(res);

    const { groupId } = req.query;
    if (!groupId) {
        res.status(400).json({ message: 'groupId es obligatorio.' });
        return;
    }

    try {
        // Ordenar miembros del grupo por puntos desc, luego por cantidad de exactos desc
        const snapshot = await db.collection('groups').doc(groupId as string).collection('members')
            .orderBy('points', 'desc')
            .orderBy('exactMatches', 'desc')
            .get();

        if (snapshot.empty) {
            res.json({ message: '🏆 Aún no hay participantes en la tabla de posiciones de este grupo.' });
            return;
        }

        let responseText = '🏆 *TABLA DE POSICIONES* 🏆\n──────────────────\n';
        let position = 1;

        snapshot.forEach(doc => {
            const user = doc.data();
            let medal = '🏅';
            if (position === 1) medal = '🥇';
            else if (position === 2) medal = '🥈';
            else if (position === 3) medal = '🥉';

            responseText += `${medal} *${position}. ${user.name}* — ${user.points} pts _(${user.exactMatches} exactos)_\n`;
            position++;
        });

        responseText += '──────────────────\n_¡Demuestra quién sabe más de fútbol!_ ⚽';
        res.json({ message: responseText });
    } catch (error: any) {
        res.status(500).json({ message: `Error al obtener tabla de posiciones: ${error.message}` });
    }
});

/**
 * 7. Cargar resultado real de un partido y calcular puntos (Admin)
 */
export const actualizarResultado = onRequest({ invoker: 'public' }, async (req, res) => {
    if (!isAuthorized(req)) return sendUnauthorized(res);

    const { userId, matchId, scoreA, scoreB } = req.body;
    if (!userId || !matchId || scoreA === undefined || scoreB === undefined) {
        res.status(400).json({ message: 'Faltan parámetros requeridos: userId, matchId, scoreA, scoreB.' });
        return;
    }

    try {
        // Validar rol de administrador
        const userDoc = await db.collection('users').doc(userId).get();
        if (!userDoc.exists || !userDoc.data()?.admin) {
            res.status(403).json({ message: '⚠️ No tienes permisos de administrador para realizar esta acción.' });
            return;
        }

        const matchRef = db.collection('matches').doc(matchId);
        const matchDoc = await matchRef.get();

        if (!matchDoc.exists) {
            res.json({ message: `⚠️ El partido con ID *${matchId}* no existe.` });
            return;
        }

        const match = matchDoc.data()!;
        const wasFinished = match.status === 'finished';

        // Actualizar el estado del partido a finalizado con sus goles
        await matchRef.update({
            scoreA,
            scoreB,
            status: 'finished'
        });

        // Obtener todas las predicciones para este partido (de todos los grupos)
        const predictionsSnapshot = await db.collection('predictions').where('matchId', '==', matchId).get();

        if (predictionsSnapshot.empty) {
            res.json({
                message: `🏁 Resultado cargado:\n⚽ *${match.teamA} ${scoreA} - ${scoreB} ${match.teamB}*\n\n⚠️ Nadie pronosticó este partido en ningún grupo.`
            });
            return;
        }

        const batch = db.batch();
        let summaryText = `🏁 *RESULTADO REGISTRADO* 🏁\n──────────────────\n⚽ *${match.teamA} ${scoreA} - ${scoreB} ${match.teamB}*\n\nPuntos repartidos:\n`;

        // Procesar cada predicción
        for (const doc of predictionsSnapshot.docs) {
            const pred = doc.data();
            const predA = pred.predictA;
            const predB = pred.predictB;
            const predUserId = pred.userId;
            const predGroupId = pred.groupId;

            // Calcular puntos obtenidos
            let pointsEarned = 0;
            let isExact = false;

            if (predA === scoreA && predB === scoreB) {
                pointsEarned = 3;
                isExact = true;
            } else if (
                (predA > predB && scoreA > scoreB) ||
                (predA < predB && scoreA < scoreB) ||
                (predA === predB && scoreA === scoreB)
            ) {
                pointsEarned = 1;
            }

            const oldPoints = wasFinished ? (pred.pointsEarned || 0) : 0;
            const oldExact = wasFinished ? (pred.isExact ? 1 : 0) : 0;

            const netPoints = pointsEarned - oldPoints;
            const netExact = (isExact ? 1 : 0) - oldExact;

            // Actualizar la predicción
            const predRef = db.collection('predictions').doc(doc.id);
            batch.update(predRef, {
                pointsEarned,
                isExact
            });

            // Actualizar el usuario en el grupo correspondiente
            const memberRef = db.collection('groups').doc(predGroupId).collection('members').doc(predUserId);
            batch.update(memberRef, {
                points: FieldValue.increment(netPoints),
                exactMatches: FieldValue.increment(netExact)
            });

            const detailEmoji = pointsEarned === 3 ? '🔥 Exacto! (+3)' : pointsEarned === 1 ? '✅ Acertó (+1)' : '❌ Falló (+0)';
            summaryText += `👤 *${pred.userName}* (Grupo ${predGroupId.substring(0,6)}...): ${predA}-${predB} (${detailEmoji})\n`;
        }

        // Ejecutar todas las actualizaciones de base de datos
        await batch.commit();

        summaryText += '──────────────────\n_Usa `!ranking` para ver cómo quedó la tabla de posiciones._';
        res.json({ message: summaryText });
    } catch (error: any) {
        res.status(500).json({ message: `Error al actualizar resultado: ${error.message}` });
    }
});

/**
 * 8. Obtener resultados de partidos finalizados o jugándose
 */
export const obtenerResultados = onRequest({ invoker: 'public' }, async (req, res) => {
    if (!isAuthorized(req)) return sendUnauthorized(res);

    try {
        const snapshot = await db.collection('matches').orderBy('date', 'desc').get();
        
        // Filtrar partidos finalizados o en juego
        const finishedMatches: any[] = [];
        snapshot.forEach(doc => {
            const data = doc.data();
            if (data.status === 'finished' || data.status === 'playing') {
                finishedMatches.push({ id: doc.id, ...data });
            }
        });

        if (finishedMatches.length === 0) {
            res.json({ message: '🏁 No hay resultados registrados en este momento.' });
            return;
        }

        let responseText = '🏁 *RESULTADOS DE PARTIDOS* 🏁\n──────────────────\n';
        
        finishedMatches.forEach(match => {
            const statusEmoji = match.status === 'finished' ? '🏁' : '🎮';
            const scoreText = match.status === 'finished' 
                ? `*${match.scoreA} - ${match.scoreB}*`
                : `_Jugándose_`;

            responseText += `👉 *ID: ${match.id}* | *${match.teamA}* ${scoreText} *${match.teamB}* ${statusEmoji}\n\n`;
        });

        responseText += '──────────────────';
        res.json({ message: responseText });
    } catch (error: any) {
        res.status(500).json({ message: `Error al obtener resultados: ${error.message}` });
    }
});
