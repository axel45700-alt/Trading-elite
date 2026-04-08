const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Stripe = require("stripe");
const https = require("https");

admin.initializeApp();
const db = admin.firestore();

// Initialiser Stripe une seule fois
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ==================== TELEGRAM ====================

function getTelegramInviteLink(uid, email) {
    return new Promise((resolve, reject) => {
        const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
        const chatId = (process.env.TELEGRAM_GROUP_ID || "").trim();
        console.log("Telegram token prefix:", token.substring(0, 10));
        console.log("Telegram chatId:", chatId);

        const options = {
            hostname: "api.telegram.org",
            path: `/bot${token}/getMe`,
            method: "GET"
        };

        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                console.log("Telegram status:", res.statusCode);
                console.log("Telegram raw response:", data);

                try {
                    const json = JSON.parse(data);
                    if (json.ok) resolve("ok");
                    else reject(new Error(json.description || data));
                } catch (err) {
                    reject(new Error(data));
                }
            });
        });

        req.on("error", reject);
        req.end();
    });
}
// ==================== STRIPE CHECKOUT ====================

exports.createCheckoutSession = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "L'utilisateur doit être authentifié");
    }

    const uid = context.auth.uid;

    try {
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

        // Créer ou récupérer le customer Stripe
        let customerId = userData.stripeCustomerId;
        if (!customerId) {
            const customer = await stripe.customers.create({ email: email });
            customerId = customer.id;
            await snapshot.docs[0].ref.update({ stripeCustomerId: customerId });
        }

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ["card"],
            mode: "subscription",
            customer: customerId,
            line_items: [
                {
                    price_data: {
                        currency: "eur",
                        product: process.env.STRIPE_PRODUCT_ID,
                        unit_amount: Math.round(prixFinal * 100),
                        recurring: { interval: "month" },
                    },
                    quantity: 1,
                },
            ],
            success_url: "https://trading-elite.firebaseapp.com/account.html?payment=success",
            cancel_url: "https://trading-elite.firebaseapp.com/account.html?payment=cancelled",
            metadata: {
                uid: uid,
            },
        });

        return { sessionId: session.id, url: session.url };
    } catch (error) {
        console.error("Erreur Stripe:", error);
        throw new functions.https.HttpsError("internal", "Erreur lors de la création de la session de paiement");
    }
});

// ==================== STRIPE WEBHOOK ====================

exports.stripeWebhook = functions.https.onRequest(async (req, res) => {
    const sig = req.headers["stripe-signature"];
    let event;

    // Essayer les deux secrets (VIP webhook et Robot webhook)
    const secrets = [
        process.env.STRIPE_WEBHOOK_SECRET,
        process.env.STRIPE_WEBHOOK_SECRET_ROBOT,
    ].filter(Boolean);

    let verified = false;
    for (const secret of secrets) {
        try {
            event = stripe.webhooks.constructEvent(req.rawBody, sig, secret);
            verified = true;
            break;
        } catch (err) {
            // Essayer le prochain secret
        }
    }

    if (!verified) {
        console.error("Webhook signature verification failed for all secrets");
        res.status(400).send("Webhook Error: Invalid signature");
        return;
    }

    try {
        switch (event.type) {
            // Quand l'abonnement est créé via checkout
            case "checkout.session.completed": {
                const session = event.data.object;

                // Anti-doublon : vérifier si cette session a déjà été traitée
                const processedRef = db.collection("processedSessions").doc(session.id);
                const alreadyProcessed = await processedRef.get();
                if (alreadyProcessed.exists) {
                    console.log(`Session ${session.id} déjà traitée, ignorée`);
                    break;
                }
                await processedRef.set({ processedAt: admin.firestore.FieldValue.serverTimestamp() });

                const uid = session.metadata?.uid;
                // Payment Link met l'email dans customer_details.email, pas customer_email
                const email = session.customer_email || session.customer_details?.email;
                const subscriptionId = session.subscription;
                const customerId = session.customer;

                let userRef = null;
                let userData = null;

                // Si uid en metadata (createCheckoutSession), sinon chercher par email (Payment Link)
                const usersRef = db.collection("users");
                if (uid) {
                    const snapshot = await usersRef.where("uid", "==", uid).get();
                    if (!snapshot.empty) {
                        userRef = snapshot.docs[0].ref;
                        userData = snapshot.docs[0].data();
                    }
                } else if (email) {
                    const snapshot = await usersRef.where("email", "==", email).get();
                    if (!snapshot.empty) {
                        userRef = snapshot.docs[0].ref;
                        userData = snapshot.docs[0].data();
                    }
                }

                if (userRef && userData) {
                    const updateData = {
                        stripeCustomerId: customerId,
                    };

                    // Si uid présent en metadata → VIP (createCheckoutSession)
                    // Sinon → Robot (Payment Link, pas de uid en metadata)
                    const isVIP = !!uid;

                    if (!isVIP) {
                        // === ROBOT ===
                        const robotLicenseKey = `ELT-${Math.random().toString(36).substring(2, 10).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;

                        await db.collection("licenses").add({
                            key: robotLicenseKey,
                            email: email || userData.email,
                            uid: userData.uid,
                            type: "Robot",
                            dateCreation: admin.firestore.FieldValue.serverTimestamp(),
                            active: true,
                        });

                        // Customer ID et subscription ID Robot séparés pour éviter le conflit avec invoice.paid VIP
                        updateData.stripeRobotCustomerId = customerId;
                        updateData.stripeRobotSubscriptionId = subscriptionId;
                        delete updateData.stripeCustomerId;
                        updateData.Robot_En_cours = true;
                        updateData.robotLicenseKey = robotLicenseKey;

                        console.log(`Licence Robot générée pour ${email}: ${robotLicenseKey}`);
                    } else {
                        // === VIP ===
                        updateData.abonne = true;
                        updateData.stripeSubscriptionId = subscriptionId;
                        updateData.dateAbonn = admin.firestore.FieldValue.serverTimestamp();

                        // Récupérer le lien Telegram du canal
                        try {
                           const inviteLink = await getTelegramInviteLink(uid, email || userData.email);
                            updateData.telegramInviteLink = inviteLink;
                            console.log(`Lien Telegram récupéré pour ${email}: ${inviteLink}`);
                        } catch (e) {
                            console.error("Erreur récupération lien Telegram:", e.message);
                        }

                        console.log(`VIP activé pour ${email}`);
                    }

                    // Mettre à jour le profil utilisateur
                    await userRef.update(updateData);
                    console.log(`Paiement traité pour ${email || userData.email}`);

                    // Appliquer la réduction au parrain (seulement pour VIP)
                    if (isVIP) {
                        const parrainTel = userData.parrain;
                        if (parrainTel) {
                            const parrainSnapshot = await usersRef.where("telephone", "==", parrainTel).get();
                            if (!parrainSnapshot.empty) {
                                const parrainData = parrainSnapshot.docs[0].data();
                                const currentFilleuls = parrainData.nombre_Filleul || 0;
                                const newFilleuls = currentFilleuls + 1;
                                const newPrice = Math.max(0, 60 - Math.min(newFilleuls, 4) * 15);

                                await parrainSnapshot.docs[0].ref.update({
                                    nombre_Filleul: newFilleuls,
                                    prixMensuel: newPrice,
                                });
                                console.log(`Parrain ${parrainTel}: +1 filleul payant, prix -> ${newPrice}€`);

                                // Mettre à jour l'abonnement Stripe du parrain
                                const parrainSubId = parrainData.stripeSubscriptionId;
                                if (parrainSubId) {
                                    const parrainSub = await stripe.subscriptions.retrieve(parrainSubId);
                                    const currentItem = parrainSub.items.data[0];
                                    await stripe.subscriptions.update(parrainSubId, {
                                        items: [{
                                            id: currentItem.id,
                                            price_data: {
                                                currency: "eur",
                                                product: process.env.STRIPE_PRODUCT_ID,
                                                unit_amount: Math.round(newPrice * 100),
                                                recurring: { interval: "month" },
                                            },
                                        }],
                                        proration_behavior: "none",
                                    });
                                    console.log(`Prix Stripe parrain mis à jour: ${newPrice}€/mois`);
                                }
                            }
                        }
                    }
                }
                break;
            }

            // Paiement mensuel réussi
            case "invoice.paid": {
                const invoice = event.data.object;
                const customerId = invoice.customer;

                const usersRef = db.collection("users");
                const snapshot = await usersRef.where("stripeCustomerId", "==", customerId).get();
                if (!snapshot.empty) {
                    await snapshot.docs[0].ref.update({
                        abonne: true,
                        dernierPaiement: admin.firestore.FieldValue.serverTimestamp(),
                    });
                    console.log(`Paiement mensuel reçu pour customer: ${customerId}`);
                }
                break;
            }

            // Paiement échoué
            case "invoice.payment_failed": {
                const invoice = event.data.object;
                const customerId = invoice.customer;

                const usersRef = db.collection("users");
                const snapshot = await usersRef.where("stripeCustomerId", "==", customerId).get();
                if (!snapshot.empty) {
                    await snapshot.docs[0].ref.update({ abonne: false });
                    console.log(`Paiement échoué pour customer: ${customerId}`);
                }
                break;
            }

            // Abonnement annulé
            case "customer.subscription.deleted": {
                const subscription = event.data.object;
                const customerId = subscription.customer;
                const usersRef = db.collection("users");

                // Vérifier si c'est un VIP
                const vipSnapshot = await usersRef.where("stripeCustomerId", "==", customerId).get();
                if (!vipSnapshot.empty) {
                    await vipSnapshot.docs[0].ref.update({ abonne: false, stripeSubscriptionId: null });
                    console.log(`Abonnement VIP annulé pour customer: ${customerId}`);
                    break;
                }

                // Vérifier si c'est un Robot
                const robotSnapshot = await usersRef.where("stripeRobotCustomerId", "==", customerId).get();
                if (!robotSnapshot.empty) {
                    const robotUserData = robotSnapshot.docs[0].data();
                    // Supprimer la licence Robot dans la collection licenses
                    if (robotUserData.robotLicenseKey) {
                        const licSnap = await db.collection("licenses").where("key", "==", robotUserData.robotLicenseKey).get();
                        for (const doc of licSnap.docs) await doc.ref.delete();
                    }
                    await robotSnapshot.docs[0].ref.update({
                        Robot_En_cours: false,
                        robotLicenseKey: null,
                        stripeRobotSubscriptionId: null,
                        stripeRobotCustomerId: null,
                    });
                    console.log(`Abonnement Robot annulé pour customer: ${customerId}`);
                }
                break;
            }
        }
    } catch (error) {
        console.error("Erreur webhook:", error);
    }

    res.json({ received: true });
});

// ==================== ANNULER ABONNEMENT ====================

exports.cancelSubscription = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "L'utilisateur doit être authentifié");
    }

    const uid = context.auth.uid;

    try {
        const usersRef = db.collection("users");
        const snapshot = await usersRef.where("uid", "==", uid).get();

        if (snapshot.empty) {
            throw new functions.https.HttpsError("not-found", "Utilisateur non trouvé");
        }

        const userData = snapshot.docs[0].data();
        const subscriptionId = userData.stripeSubscriptionId;

        if (!subscriptionId) {
            throw new functions.https.HttpsError("not-found", "Aucun abonnement trouvé");
        }

        // Annuler à la fin de la période en cours
        await stripe.subscriptions.update(subscriptionId, {
            cancel_at_period_end: true,
        });

        console.log(`Abonnement ${subscriptionId} sera annulé en fin de période`);
        return { success: true, message: "Abonnement annulé en fin de période" };
    } catch (error) {
        console.error("Erreur annulation:", error);
        throw new functions.https.HttpsError("internal", "Erreur lors de l'annulation");
    }
});

// ==================== ANNULER ABONNEMENT ROBOT ====================

exports.cancelRobotSubscription = functions.https.onCall(async (data, context) => {
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "L'utilisateur doit être authentifié");
    }
    const uid = context.auth.uid;
    try {
        const snapshot = await db.collection("users").where("uid", "==", uid).get();
        if (snapshot.empty) throw new functions.https.HttpsError("not-found", "Utilisateur non trouvé");

        const userData = snapshot.docs[0].data();
        const subscriptionId = userData.stripeRobotSubscriptionId;

        if (!subscriptionId) throw new functions.https.HttpsError("not-found", "Aucun abonnement Robot trouvé");

        await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true });
        console.log(`Abonnement Robot ${subscriptionId} sera annulé en fin de période`);
        return { success: true };
    } catch (error) {
        console.error("Erreur annulation Robot:", error);
        throw new functions.https.HttpsError("internal", "Erreur lors de l'annulation");
    }
});

// ==================== MISE A JOUR PRIX FILLEUL ====================

exports.updateSubscriptionPrice = functions.https.onRequest(async (req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
        res.status(200).send("");
        return;
    }

    const { parrainTelephone } = req.body;

    try {
        // Trouver le parrain par téléphone
        const usersRef = db.collection("users");
        const snapshot = await usersRef.where("telephone", "==", parrainTelephone).get();

        if (snapshot.empty) {
            res.json({ updated: false, message: "Parrain non trouvé" });
            return;
        }

        const parrainData = snapshot.docs[0].data();
        const subscriptionId = parrainData.stripeSubscriptionId;

        if (!subscriptionId) {
            // Parrain pas encore abonné, le prix sera calculé au moment du paiement
            res.json({ updated: false, message: "Parrain pas encore abonné" });
            return;
        }

        // Calculer le nouveau prix
        const nombre_Filleul = parrainData.nombre_Filleul || 0;
        const reduction = Math.min(nombre_Filleul, 4) * 15;
        const nouveauPrix = Math.max(0, 60 - reduction);

        // Récupérer l'abonnement actuel
        const subscription = await stripe.subscriptions.retrieve(subscriptionId);
        const currentItem = subscription.items.data[0];

        // Mettre à jour le prix de l'abonnement
        await stripe.subscriptions.update(subscriptionId, {
            items: [
                {
                    id: currentItem.id,
                    price_data: {
                        currency: "eur",
                        product: process.env.STRIPE_PRODUCT_ID,
                        unit_amount: Math.round(nouveauPrix * 100),
                        recurring: { interval: "month" },
                    },
                },
            ],
            proration_behavior: "none", // Pas de prorata, le nouveau prix s'applique au prochain cycle
        });

        console.log(`Prix mis à jour pour ${parrainTelephone}: ${nouveauPrix}€/mois`);
        res.json({ updated: true, nouveauPrix: nouveauPrix });
    } catch (error) {
        console.error("Erreur updateSubscriptionPrice:", error);
        res.status(500).json({ updated: false, message: "Erreur serveur" });
    }
});

// ==================== LICENSE FUNCTIONS ====================

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

        const sessionsRef = db.collection("sessions");
        const allSessions = await sessionsRef.where("key", "==", key).get();

        for (const sessionDoc of allSessions.docs) {
            const sessionData = sessionDoc.data();
            const lastHeartbeat = sessionData.lastHeartbeat?.toDate?.() || new Date(sessionData.lastHeartbeat);
            const timeSinceHeartbeat = (new Date() - lastHeartbeat) / (1000 * 60);

            if (timeSinceHeartbeat > 120) {
                await sessionDoc.ref.delete();
            } else if (sessionData.active) {
                res.status(403).json({ valid: false, message: "Clé déjà active ailleurs" });
                return;
            }
        }

        const sessionId = Math.random().toString(36).substring(7);
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

        await snapshot.docs[0].ref.update({
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
