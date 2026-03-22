const express = require('express');
const cors = require('cors');
require('dotenv').config();
const admin = require('firebase-admin');
const Razorpay = require('razorpay');
const crypto = require('crypto');

const app = express();

// Initialize Firebase Admin
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

let db;
try {
    if (admin.apps.length === 0) {
        const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
            projectId: process.env.FIREBASE_PROJECT_ID,
        });
    }
    db = admin.firestore();
} catch (error) {
    console.error('❌ Error Initializing Firebase Admin:', error);
    db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: false }), set: async () => {}, update: async () => {} }) }) };
}

// Initialize Razorpay
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    try {
        razorpay = new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET });
    } catch (error) {
        console.error('❌ Error initializing Razorpay');
    }
}

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('.'));

const getTodayString = () => new Date().toISOString().split('T')[0];

app.get('/api/get-firebase-config', (req, res) => res.json(firebaseConfig));
app.get('/api/get-payment-config', (req, res) => res.json({ keyId: process.env.RAZORPAY_KEY_ID }));

// 🚀 1. BULLETPROOF: Verify Phone Auth (New Gmail Logic)
app.post('/api/verify-phone-auth', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        if (!uid || !email) return res.status(400).json({ error: 'Missing uid' });

        const today = getTodayString();
        const userRef = db.collection('users').doc(uid);
        const userDoc = await userRef.get();

        if (!userDoc.exists) {
            // Brand new account - Set strictly to 0
            await userRef.set({
                email: email,
                displayName: displayName || null,
                createdAt: new Date(),
                trialsUsed: 0,
                lastTrialDate: today,
                verified: true,
                status: 'free',
                isPro: false
            });
        }
        res.json({ success: true, message: 'User verified' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🚀 2. BULLETPROOF: Get User Credits (The root cause of "0" on load)
app.post('/api/get-user-credits', async (req, res) => {
    try {
        const uid = req.body.uid || req.headers['x-user-id'];
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        const userDoc = await db.collection('users').doc(uid).get();
        
        // If doc is missing for any reason, force 2 trials. Never 0.
        if (!userDoc.exists) {
            return res.json({ status: 'free', uploadCount: 0, canUpload: true, freeTrialsRemaining: 2, daysRemaining: 0 });
        }

        let userData = userDoc.data() || {};
        let isPro = userData.isPro || userData.status === 'Pro' || false;
        const today = getTodayString();
        
        // Handle Pro Expiry safely
        let daysRemaining = 0;
        if (isPro && userData.expiryDate) {
            const expiryDate = userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate);
            if (new Date() > expiryDate) {
                isPro = false;
                await db.collection('users').doc(uid).update({ status: 'free', isPro: false }).catch(() => {});
            } else {
                daysRemaining = Math.max(0, Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24)));
            }
        }

        const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
        let trialsUsed = 0;

        // Strict Math parsing to avoid NaN errors sending "0" to frontend
        if (lastTrialDate === today) {
            if (userData.trialsUsed !== undefined) trialsUsed = Number(userData.trialsUsed);
            else if (userData.testsUsedToday !== undefined) trialsUsed = Number(userData.testsUsedToday);
            if (isNaN(trialsUsed)) trialsUsed = 0;
        }

        // If date didn't match, force reset to 0 in DB right now
        if (lastTrialDate !== today) {
            trialsUsed = 0;
            await db.collection('users').doc(uid).update({ trialsUsed: 0, lastTrialDate: today }).catch(() => {});
        }

        res.json({
            status: isPro ? 'Pro' : 'free',
            uploadCount: trialsUsed,
            canUpload: isPro || trialsUsed < 2,
            freeTrialsRemaining: isPro ? 999 : Math.max(0, 2 - trialsUsed),
            daysRemaining: daysRemaining
        });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// 🚀 3. BULLETPROOF: Check Upload Limit
app.post('/api/check-upload-limit', async (req, res) => {
    try {
        const uid = req.body.uid || req.headers['x-user-id'];
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.json({ canUpload: true, uploadCount: 0 });

        let userData = userDoc.data() || {};
        let isPro = userData.isPro || userData.status === 'Pro' || false;
        const today = getTodayString();
        const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
        
        let trialsUsed = 0;
        if (lastTrialDate === today) {
            if (userData.trialsUsed !== undefined) trialsUsed = Number(userData.trialsUsed);
            else if (userData.testsUsedToday !== undefined) trialsUsed = Number(userData.testsUsedToday);
            if (isNaN(trialsUsed)) trialsUsed = 0;
        }

        if (isPro) return res.json({ canUpload: true, status: 'Pro', isPro: true });
        if (trialsUsed >= 2) return res.json({ canUpload: false, uploadCount: trialsUsed, reason: 'Free limit reached', status: 'free' });

        res.json({ canUpload: true, uploadCount: trialsUsed, uploadsRemaining: Math.max(0, 2 - trialsUsed), status: 'free' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 🚀 4. BULLETPROOF: Analyze (The Main Engine)
app.post('/api/analyze', async (req, res) => {
    try {
        const { base64, mimeType, base64_b, mimeType_b } = req.body;
        const uid = req.body.uid || req.headers['x-user-id'];

        if (!base64 || !mimeType) return res.status(400).json({ error: 'Missing base64 or mimeType' });
        if (!uid) return res.status(401).json({ error: 'userNotFound', message: 'Please Login First' });

        const today = getTodayString();
        const userRef = db.collection('users').doc(uid);
        const userSnap = await userRef.get();
        
        let isPro = false;
        let trialsUsed = 0;
        
        if (userSnap.exists) {
            const uData = userSnap.data() || {};
            isPro = uData.isPro || uData.status === 'Pro' || false;
            
            if (isPro && uData.expiryDate) {
                const expiry = uData.expiryDate.toDate ? uData.expiryDate.toDate() : new Date(uData.expiryDate);
                if (new Date() > expiry) isPro = false;
            }
            
            const lastTrialDate = uData.lastTrialDate || uData.lastTestDate || null;
            if (lastTrialDate === today) {
                if (uData.trialsUsed !== undefined) trialsUsed = Number(uData.trialsUsed);
                else if (uData.testsUsedToday !== undefined) trialsUsed = Number(uData.testsUsedToday);
                if (isNaN(trialsUsed)) trialsUsed = 0;
            }
        }

        if (!isPro && trialsUsed >= 2) {
            return res.status(403).json({ error: 'noCredits', message: 'Free limit reached. Upgrade to Pro.' });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key missing' });

        const isABTest = !!(base64_b && mimeType_b);
        let messages = [];

        if (isABTest) {
            messages = [{
                role: 'user',
                content: [
                    { type: 'text', text: "Compare these two YouTube thumbnails (Thumbnail A is the first, Thumbnail B is the second). Analyze their CTR potential and declare a clear winner. Return ONLY a JSON object with 'winner' (either 'Thumbnail A' or 'Thumbnail B') and 'explanation' (2-3 sentences explaining why it's better). No extra text, no markdown." },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } },
                    { type: 'image_url', image_url: { url: `data:${mimeType_b};base64,${base64_b}` } }
                ]
            }];
        } else {
            messages = [{
                role: 'user',
                content: [
                    { type: 'text', text: "Analyze this YouTube thumbnail for CTR potential. Return ONLY a JSON object with 'thumbnailScore' (0-100 number), 'titleScore' (0-100 number), 'combinedScore' (0-100 number), 'tips' (array of exactly 3 actionable English tips), and 'analysis' (2-3 sentences). No extra text, no markdown." },
                    { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
                ]
            }];
        }

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({ model: 'google/gemini-2.0-flash-lite-001', messages: messages })
        });

        const data = await response.json();
        if (data.error) return res.status(400).json({ error: data.error.message });

        const aiText = data.choices[0].message.content.replace(/```json|```/g, '').trim();
        const finalResult = JSON.parse(aiText);

        if (!isPro) {
            try {
                await db.runTransaction(async (transaction) => {
                    const userDoc = await transaction.get(userRef);
                    if (!userDoc.exists) {
                        transaction.set(userRef, { isPro: false, status: 'free', createdAt: new Date(), trialsUsed: 1, lastTrialDate: today }, { merge: true });
                    } else {
                        const uData = userDoc.data() || {};
                        const lastDate = uData.lastTrialDate || uData.lastTestDate || null;
                        let currTrials = 0;
                        if (lastDate === today) {
                            if (uData.trialsUsed !== undefined) currTrials = Number(uData.trialsUsed);
                            else if (uData.testsUsedToday !== undefined) currTrials = Number(uData.testsUsedToday);
                            if (isNaN(currTrials)) currTrials = 0;
                        }
                        
                        transaction.set(userRef, {
                            trialsUsed: currTrials + 1,
                            lastTrialDate: today
                        }, { merge: true });
                    }
                });
            } catch (txError) { console.error('Transaction Error:', txError); }
        }

        res.json(finalResult);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { uid, amount } = req.body;
        if (!uid || !amount) return res.status(400).json({ error: 'Missing fields' });
        if (!razorpay) return res.json({ orderID: `order_dummy_${Date.now()}`, currency: 'INR', amount: amount * 100, isDummy: true });

        const order = await razorpay.orders.create({
            amount: amount * 100, currency: 'INR', receipt: `rcpt_${Date.now()}`, notes: { uid: uid }
        });
        return res.status(200).json({ orderID: order.id, currency: order.currency, amount: order.amount, isDummy: false });
    } catch (outerErr) { return res.status(500).json({ error: outerErr.message, isDummy: false }); }
});

// Verify Razorpay Payment
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { uid, razorpay_payment_id, razorpay_order_id, razorpay_signature } = req.body;
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

        if (expectedSignature !== razorpay_signature) return res.status(400).json({ error: 'Signature failed' });

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);

        await db.collection('users').doc(uid).update({
            isPro: true, status: 'Pro', expiryDate: expiryDate, lastPaymentDate: new Date()
        });

        res.json({ success: true, message: 'Pro activated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'Server is running' }));
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => { console.log(`✅ Server running on http://localhost:${PORT}`); });