const functions = require("firebase-functions");
const admin = require("firebase-admin");
const stripe = require("stripe")(process.env.STRIPE_SECRET_KEY);

admin.initializeApp();
const db = admin.firestore();

exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
    // Vérifier que l'utilisateur est authentifié
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "L'utilisateur doit être authentifié");
    }

    const uid = context.auth.uid;

    try {
        // Récupérer les données de l'utilisateur
        const usersRef = db.collection("users");
        const snapshot = await usersRef.where("uid", "==", uid).get();

        if (snapshot.empty) {
            throw new functions.https.HttpsError("not-found", "Utilisateur non trouvé");
        }

        const userData = snapshot.docs[0].data();
        const nombre_Filleul = userData.nombre_Filleul || 0;
        const email = userData.email;

        // Calculer le prix : 60€ - (15€ * nombre_Filleul), max 4 filleuls
        const reduction = Math.min(nombre_Filleul, 4) * 15;
        const prixFinal = Math.max(0, 60 - reduction);

        // Créer la session Stripe
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "payment",
            customer_email: email,
            line_items: [
                {
                    price_data: {
                        currency: "eur",
                        product: process.env.STRIPE_PRODUCT_ID,
                        unit_amount: Math.round(prixFinal * 100), // Montant en centimes
                    },
                    quantity: 1,
                },
            ],
            success_url: "https://trading-elite.firebaseapp.com/account.html?payment=success",
            cancel_url: "https://trading-elite.firebaseapp.com/account.html?payment=cancelled",
            metadata: {
                uid: uid,
                nombre_Filleul: nombre_Filleul.toString(),
            },
        });

        return { sessionId: session.id, url: session.url };
    } catch (error) {
        console.error("Erreur Stripe:", error);
        throw new functions.https.HttpsError("internal", "Erreur lors de la création de la session de paiement");
    }
});

// Webhook Stripe pour confirmer le paiement
exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    try {
        event = stripe.webhooks.constructEvent(
            req.rawBody,
            sig,
            process.env.STRIPE_WEBHOOK_SECRET
        );
    } catch (err) {
        res.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }

    if (event.type === "checkout.session.completed") {
        const session = event.data.object;
        const uid = session.metadata.uid;

        try {
            const usersRef = db.collection("users");
            const snapshot = await usersRef.where("uid", "==", uid).get();

            if (!snapshot.empty) {
                await snapshot.docs[0].ref.update({
                    abonne: true,
                    dateAbonn: admin.firestore.FieldValue.serverTimestamp(),
                });
            }
        } catch (error) {
            console.error("Erreur update Firestore:", error);
        }
    }

    res.json({ received: true });
});

// LICENSE FUNCTIONS
exports.activateKey = functions.https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.status(200).send("");
        return;
    }

    const { email, key } = req.body;

    try {
        const licensesRef = db.collection("licenses");
        const snapshot = await licensesRef.where("key", "==", key).get();

        if (snapshot.empty) {
            res.status(401).json({ valid: false, message: "Clé invalide" });
            return;
        }

        const licenseDoc = snapshot.docs[0];
        const licenseData = licenseDoc.data();

        if (licenseData.email !== email) {
            res.status(401).json({ valid: false, message: "Email ne correspond pas" });
            return;
        }

        // Vérifier les sessions actives et nettoyer les expirées
        const sessionsRef = db.collection("sessions");
        const allSessions = await sessionsRef
            .where("key", "==", key)
            .get();

        for (const sessionDoc of allSessions.docs) {
            const sessionData = sessionDoc.data();
            const lastHeartbeat = sessionData.lastHeartbeat?.toDate?.() || new Date(sessionData.lastHeartbeat);
            const timeSinceHeartbeat = (new Date() - lastHeartbeat) / (1000 * 60); // minutes

            if (timeSinceHeartbeat > 120) {
                // Session expirée, la supprimer
                await sessionDoc.ref.delete();
            } else if (sessionData.active) {
                // Session active récente
                res.status(403).json({ valid: false, message: "Clé déjà active ailleurs" });
                return;
            }
        }

        // Créer nouvelle session
        const sessionId = admin.firestore.FieldValue.serverTimestamp ? Math.random().toString(36).substring(7) : "session_" + Date.now();
        await sessionsRef.add({
            key: key,
            email: email,
            sessionId: sessionId,
            active: true,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastHeartbeat: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ valid: true, sessionId: sessionId });
    } catch (error) {
        console.error("Erreur activateKey:", error);
        res.status(500).json({ valid: false, message: "Erreur serveur" });
    }
});

exports.heartbeat = functions.https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.status(200).send("");
        return;
    }

    const { sessionId, key } = req.body;

    try {
        const sessionsRef = db.collection("sessions");
        const snapshot = await sessionsRef
            .where("sessionId", "==", sessionId)
            .where("key", "==", key)
            .get();

        if (snapshot.empty) {
            res.status(401).json({ valid: false });
            return;
        }

        const sessionDoc = snapshot.docs[0];
        await sessionDoc.ref.update({
            lastHeartbeat: admin.firestore.FieldValue.serverTimestamp()
        });

        res.json({ valid: true });
    } catch (error) {
        console.error("Erreur heartbeat:", error);
        res.status(500).json({ valid: false });
    }
});

exports.deactivateKey = functions.https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.status(200).send("");
        return;
    }

    const { sessionId, key } = req.body;

    try {
        const sessionsRef = db.collection("sessions");
        const snapshot = await sessionsRef
            .where("sessionId", "==", sessionId)
            .where("key", "==", key)
            .get();

        if (!snapshot.empty) {
            await snapshot.docs[0].ref.delete();
        }

        res.json({ deactivated: true });
    } catch (error) {
        console.error("Erreur deactivateKey:", error);
        res.status(500).json({ deactivated: false });
    }
});
