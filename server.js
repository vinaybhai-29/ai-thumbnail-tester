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

// Initialize Firebase Admin with service account
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
    console.error('❌ Error Initializing Firebase Admin. Server may not function correctly:', error);
    const dummyDoc = {
        get: async () => ({ exists: false, data: () => ({}) }),
        set: async () => {},
        update: async () => {},
        collection: () => dummyCollection
    };
    const dummyCollection = {
        doc: () => dummyDoc,
        add: async () => ({ id: 'dummy_id' }),
        where: () => ({ get: async () => ({ empty: true, docs: [] }) })
    };
    db = { collection: () => dummyCollection };
}

// Initialize Razorpay
let razorpay = null;
console.log('\n🔑 ===== RAZORPAY INITIALIZATION DEBUG =====');
console.log('RAZORPAY_KEY_ID exists:', !!process.env.RAZORPAY_KEY_ID);
console.log('RAZORPAY_KEY_SECRET exists:', !!process.env.RAZORPAY_KEY_SECRET);

if (process.env.RAZORPAY_KEY_ID) {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const maskedKeyId = keyId.substring(0, 8) + '...' + keyId.substring(keyId.length - 4);
    console.log('RAZORPAY_KEY_ID (masked):', maskedKeyId);
} else {
    console.warn('❌ RAZORPAY_KEY_ID is NOT set in environment');
}

if (process.env.RAZORPAY_KEY_SECRET) {
    const secret = process.env.RAZORPAY_KEY_SECRET;
    const maskedSecret = secret.substring(0, 4) + '...' + secret.substring(secret.length - 4);
    console.log('RAZORPAY_KEY_SECRET (masked):', maskedSecret);
} else {
    console.warn('❌ RAZORPAY_KEY_SECRET is NOT set in environment');
}

if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    try {
        console.log('\n📍 Attempting to initialize Razorpay SDK...');
        razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET
        });
        console.log('✅ SUCCESS: Razorpay SDK initialized successfully');
    } catch (error) {
        console.error('❌ FAILED: Error initializing Razorpay SDK');
        console.error('Error Message:', error.message);
        razorpay = null;
    }
} else {
    console.warn('\n⚠️  WARNING: Razorpay keys not fully configured.');
}
console.log('🔑 ===== END RAZORPAY DEBUG =====\n');

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('.'));

// Helpers for unified trial tracking
const getTodayString = () => new Date().toISOString().split('T')[0];

// Endpoint to provide Firebase config to client
app.get('/api/get-firebase-config', (req, res) => {
    res.json(firebaseConfig);
});

// Endpoint to provide public Razorpay Key ID to client
app.get('/api/get-payment-config', (req, res) => {
    res.json({
        keyId: process.env.RAZORPAY_KEY_ID
    });
});

// Backend API endpoint for thumbnail analysis
app.post('/api/analyze-thumbnail', async (req, res) => {
    try {
        const { base64, mimeType } = req.body;
        const uid = req.body.uid || req.headers['x-user-id'];

        if (!base64 || !mimeType) {
            return res.status(400).json({ error: 'Missing base64 or mimeType' });
        }

        const today = getTodayString();

        if (uid) {
            let userDoc = await db.collection('users').doc(uid).get();
            
            if (!userDoc.exists) {
                await db.collection('users').doc(uid).set({
                    createdAt: new Date(),
                    trialsUsed: 0,
                    totalTrialsUsed: 0,
                    lastTrialDate: today,
                    status: 'free'
                });
                userDoc = await db.collection('users').doc(uid).get();
            }
            
            const userData = userDoc.data();
            let isPro = userData.isPro || userData.status === 'Pro';

            if (isPro) {
                const expiry = userData.expiryDate ? (userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate)) : null;
                if (expiry && new Date() <= expiry) {
                    // Still Pro
                } else {
                    isPro = false;
                    await db.collection('users').doc(uid).update({ isPro: false, status: 'free', uploadCount: 0 });
                }
            }

            const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
            let currentTrials = userData.trialsUsed !== undefined ? userData.trialsUsed : (userData.testsUsedToday || 0);
            if (lastTrialDate !== today) {
                currentTrials = 0;
            }

            if (!isPro && currentTrials >= 2) {
                return res.status(403).json({ error: 'noCredits', message: 'Free trials exhausted for today.' });
            }
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: 'google/gemini-2.0-flash-lite-001',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: "Analyze this YouTube thumbnail for CTR potential. Return ONLY a JSON object with 'score' (0-100 number) and 'tips' (array of exactly 3 improvement tips in English language). No extra text, no markdown." },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
                    ]
                }]
            })
        });

        const data = await response.json();
        if (data.error) return res.status(400).json({ error: data.error.message });

        const aiText = data.choices[0].message.content.replace(/```json|```/g, '').trim();
        const final = JSON.parse(aiText);

        if (uid) {
            try {
                const userDoc = await db.collection('users').doc(uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
                    let currentTrials = userData.trialsUsed !== undefined ? userData.trialsUsed : (userData.testsUsedToday || 0);
                    
                    if (lastTrialDate !== today) currentTrials = 0;
                    
                    await db.collection('users').doc(uid).update({
                        trialsUsed: currentTrials + 1,
                        totalTrialsUsed: (userData.totalTrialsUsed || userData.totalTestsUsed || 0) + 1,
                        lastTrialDate: today
                    });
                }
            } catch (updateErr) {
                console.error('Error updating test usage:', updateErr);
            }
        }

        res.json(final);
    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Generate Better Titles
app.post('/api/generate-titles', async (req, res) => {
    try {
        const { title } = req.body;
        const uid = req.body.uid || req.headers['x-user-id'];

        if (!title || title.trim().length === 0) {
            return res.status(400).json({ error: 'Missing title input' });
        }
        if (!uid) {
            return res.status(401).json({ error: 'unauthorized', message: 'Missing user ID. Please login first.' });
        }

        const today = getTodayString();
        let userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) {
            await db.collection('users').doc(uid).set({
                createdAt: new Date(),
                trialsUsed: 0,
                totalTrialsUsed: 0,
                lastTrialDate: today,
                status: 'free'
            });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'google/gemini-2.0-flash-lite-001',
                messages: [{
                    role: 'user',
                    content: `You are a YouTube title expert. Generate 5 catchy, clickable, and SEO-optimized titles based on this input: "${title}". Return ONLY a JSON object with a 'titles' array containing exactly 5 title strings. Make them engaging, with power words, and between 40-60 characters. No extra text, no markdown.`
                }]
            })
        });

        const data = await response.json();
        if (data.error) return res.status(400).json({ error: data.error.message });

        const aiText = data.choices[0].message.content.replace(/```json|```/g, '').trim();
        let titles;
        try { titles = JSON.parse(aiText); } 
        catch (parseErr) { return res.status(500).json({ error: 'Failed to parse titles.' }); }
        
        res.json(titles);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Combined Analysis (Thumbnail + Title)
app.post('/api/analyze-combined', async (req, res) => {
    try {
        const { base64, mimeType, title } = req.body;
        const uid = req.body.uid || req.headers['x-user-id'];
        const today = getTodayString();

        if (!base64 || !mimeType || !title) return res.status(400).json({ error: 'Missing base64, mimeType, or title' });

        if (uid) {
            let userDoc = await db.collection('users').doc(uid).get();
            if (!userDoc.exists) {
                await db.collection('users').doc(uid).set({
                    createdAt: new Date(), trialsUsed: 0, totalTrialsUsed: 0, lastTrialDate: today, status: 'free'
                });
                userDoc = await db.collection('users').doc(uid).get();
            }
            
            const userData = userDoc.data();
            let isPro = userData.isPro || userData.status === 'Pro';
            
            if (isPro) {
                const expiry = userData.expiryDate ? (userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate)) : null;
                if (expiry && new Date() > expiry) {
                    await db.collection('users').doc(uid).update({ isPro: false, status: 'free' });
                }
            }
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: 'google/gemini-2.0-flash-lite-001',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: `You are a YouTube expert. Analyze this thumbnail and title TOGETHER for clickability potential.\nTitle: "${title}"\nReturn ONLY a JSON object with:\n- 'thumbnailScore' (0-100)\n- 'titleScore' (0-100)\n- 'combinedScore' (0-100)\n- 'tips' (array of 5 actionable suggestions)\n- 'analysis' (2-3 sentences)\nNo extra text, no markdown.` },
                        { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64}` } }
                    ]
                }]
            })
        });

        const data = await response.json();
        if (data.error) return res.status(400).json({ error: data.error.message });

        const aiText = data.choices[0].message.content.replace(/```json|```/g, '').trim();
        const analysis = JSON.parse(aiText);

        if (uid) {
            try {
                const userDoc = await db.collection('users').doc(uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
                    let currentTrials = userData.trialsUsed !== undefined ? userData.trialsUsed : (userData.testsUsedToday || 0);
                    if (lastTrialDate !== today) currentTrials = 0;
                    
                    await db.collection('users').doc(uid).update({
                        trialsUsed: currentTrials + 1,
                        totalTrialsUsed: (userData.totalTrialsUsed || userData.totalTestsUsed || 0) + 1,
                        lastTrialDate: today
                    });
                }
            } catch (updateErr) { console.error('Error updating test usage:', updateErr); }
        }

        res.json(analysis);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Save user to Firestore after authentication
app.post('/api/verify-phone-auth', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        if (!uid || !email) return res.status(400).json({ error: 'Missing uid or email' });

        await db.collection('users').doc(uid).set({
            email: email,
            displayName: displayName || null,
            createdAt: new Date(),
            trialsUsed: 0,
            lastTrialDate: getTodayString(),
            verified: true
        }, { merge: true });

        res.json({ success: true, message: 'User verified and saved' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get user stats
app.post('/api/get-user-stats', async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        const userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.json({ testsRemaining: 2, totalUsed: 0 });

        const userData = userDoc.data();
        const today = getTodayString();
        const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
        let trialsUsed = userData.trialsUsed !== undefined ? userData.trialsUsed : (userData.testsUsedToday || 0);

        if (lastTrialDate !== today) {
            trialsUsed = 0;
        }

        res.json({ 
            testsRemaining: Math.max(0, 2 - trialsUsed),
            testsUsedToday: trialsUsed,
            totalUsed: userData.totalTrialsUsed || userData.totalTestsUsed || 0
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update test usage
app.post('/api/update-test-usage', async (req, res) => {
    try {
        const { uid } = req.body;
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.data() || {};
        const today = getTodayString();
        
        const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
        let trialsUsed = userData.trialsUsed !== undefined ? userData.trialsUsed : (userData.testsUsedToday || 0);

        if (lastTrialDate !== today) trialsUsed = 0;

        await db.collection('users').doc(uid).update({
            trialsUsed: trialsUsed + 1,
            totalTrialsUsed: (userData.totalTrialsUsed || userData.totalTestsUsed || 0) + 1,
            lastTrialDate: today
        });

        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnostic
app.get('/api/status', (req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    res.json({
        server: 'running',
        razorpayInitialized: !!razorpay,
        razorpayKeyIdSet: !!keyId,
        razorpayKeySecretSet: !!keySecret,
        timestamp: new Date().toISOString()
    });
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { uid, amount, creditsToAdd } = req.body;
        if (!uid || !amount || !creditsToAdd) return res.status(400).json({ error: 'Missing fields' });

        if (!razorpay) {
            return res.json({
                orderID: `order_dummy_${Date.now()}`,
                currency: 'INR',
                amount: amount * 100,
                isDummy: true
            });
        }

        const order = await razorpay.orders.create({
            amount: amount * 100,
            currency: 'INR',
            receipt: `rcpt_${Date.now()}`,
            notes: { uid: uid, creditsToAdd: creditsToAdd }
        });

        return res.status(200).json({
            orderID: order.id,
            currency: order.currency,
            amount: order.amount,
            isDummy: false
        });
    } catch (outerErr) {
        return res.status(500).json({ error: 'Server error: ' + outerErr.message, isDummy: false });
    }
});

// Verify Razorpay Payment
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { uid, razorpay_payment_id, razorpay_order_id, razorpay_signature, creditsToAdd } = req.body;
        if (!uid || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing verification fields' });
        }

        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto.createHmac('sha256', process.env.RAZORPAY_KEY_SECRET).update(body).digest('hex');

        if (expectedSignature !== razorpay_signature) {
            return res.status(400).json({ error: 'Signature verification failed' });
        }

        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 30);

        await db.collection('users').doc(uid).update({
            isPro: true,
            status: 'Pro',
            expiryDate: expiryDate,
            lastPaymentDate: new Date()
        });

        res.json({ success: true, message: 'Payment verified and Pro activated' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get User Credits (Used heavily by Frontend)
app.post('/api/get-user-credits', async (req, res) => {
    try {
        const uid = req.body.uid || req.headers['x-user-id'];
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        const userDoc = await db.collection('users').doc(uid).get();
        
        if (!userDoc.exists) {
            return res.json({ status: 'free', uploadCount: 0, canUpload: true, freeTrialsRemaining: 2, daysRemaining: 0 });
        }

        let userData = userDoc.data();
        let currentStatus = userData.status || 'free';
        let isPro = userData.isPro || currentStatus === 'Pro';
        
        const today = getTodayString();
        const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
        let trialsUsed = userData.trialsUsed !== undefined ? userData.trialsUsed : (userData.testsUsedToday || 0);

        if (lastTrialDate !== today) {
            trialsUsed = 0;
        }

        if (isPro && userData.expiryDate) {
            const expiryDate = userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate);
            if (new Date() > expiryDate) {
                currentStatus = 'free';
                isPro = false;
                await db.collection('users').doc(uid).update({ status: 'free', isPro: false });
            }
        }

        let daysRemaining = 0;
        if (isPro && userData.expiryDate) {
            const expiryDate = userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate);
            daysRemaining = Math.ceil((expiryDate - new Date()) / (1000 * 60 * 60 * 24));
        }

        res.json({
            status: isPro ? 'Pro' : 'free',
            uploadCount: trialsUsed,
            canUpload: isPro || trialsUsed < 2,
            freeTrialsRemaining: Math.max(0, 2 - trialsUsed),
            daysRemaining: Math.max(0, daysRemaining),
            expiryDate: userData.expiryDate ? (userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate)) : null
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Check Upload Limit
app.post('/api/check-upload-limit', async (req, res) => {
    try {
        const uid = req.body.uid || req.headers['x-user-id'];
        if (!uid) return res.status(400).json({ error: 'Missing uid' });

        let userDoc = await db.collection('users').doc(uid).get();
        if (!userDoc.exists) return res.json({ canUpload: true, uploadCount: 0 });

        let userData = userDoc.data();
        let isPro = userData.isPro || userData.status === 'Pro';
        
        const today = getTodayString();
        const lastTrialDate = userData.lastTrialDate || userData.lastTestDate || null;
        let trialsUsed = userData.trialsUsed !== undefined ? userData.trialsUsed : (userData.testsUsedToday || 0);

        if (lastTrialDate !== today) {
            trialsUsed = 0;
        }

        if (isPro && userData.expiryDate) {
            const expiryDate = userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate);
            if (new Date() > expiryDate) {
                isPro = false;
                await db.collection('users').doc(uid).update({ status: 'free', isPro: false });
            }
        }

        if (isPro) {
            return res.json({ canUpload: true, status: 'Pro', isPro: true });
        }

        if (trialsUsed >= 2) {
            return res.json({ canUpload: false, uploadCount: trialsUsed, reason: 'Free limit reached', status: 'free' });
        }

        res.json({ canUpload: true, uploadCount: trialsUsed, uploadsRemaining: 2 - trialsUsed, status: 'free' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Increment Upload Count
app.post('/api/increment-usage', async (req, res) => { res.json({ success: true }); });

// Unified Analysis Endpoint (The Main Engine)
app.post('/api/analyze', async (req, res) => {
    try {
        const { base64, mimeType, base64_b, mimeType_b } = req.body;
        const uid = req.body.uid || req.headers['x-user-id'];

        if (!base64 || !mimeType) {
            return res.status(400).json({ error: 'Missing base64 or mimeType for Thumbnail A' });
        }
        if (!uid) {
            return res.status(401).json({ error: 'userNotFound', message: 'Please Login First' });
        }

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
            
            // Bulletproof old user migration
            const lastTrialDate = uData.lastTrialDate || uData.lastTestDate || null;
            trialsUsed = uData.trialsUsed !== undefined ? uData.trialsUsed : (uData.testsUsedToday || 0);
            
            if (lastTrialDate !== today) {
                trialsUsed = 0; // Fresh day!
            }
        }

        if (!isPro && trialsUsed >= 2) {
            return res.status(403).json({ error: 'noCredits', message: 'Free trials exhausted. Please upgrade to Pro.' });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

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
                    { type: 'text', text: "Analyze this YouTube thumbnail for CTR potential. Return ONLY a JSON object with 'thumbnailScore' (0-100 number), 'titleScore' (0-100 number, estimate based on visual context), 'combinedScore' (0-100 number), 'tips' (array of exactly 3 actionable English tips), and 'analysis' (2-3 sentences explaining the scores). No extra text, no markdown." },
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
                        transaction.set(userRef, { 
                            isPro: false, status: 'free', createdAt: new Date(), trialsUsed: 1, lastTrialDate: today
                        }, { merge: true });
                    } else {
                        const uData = userDoc.data() || {};
                        const lastTrialDate = uData.lastTrialDate || uData.lastTestDate || null;
                        let currentTrials = (lastTrialDate === today) ? (uData.trialsUsed !== undefined ? uData.trialsUsed : (uData.testsUsedToday || 0)) : 0;
                        
                        transaction.set(userRef, {
                            isPro: uData.isPro === undefined ? false : uData.isPro,
                            trialsUsed: currentTrials + 1,
                            lastTrialDate: today
                        }, { merge: true });
                    }
                });
            } catch (txError) { console.error('Usage Transaction Error:', txError); }
        }

        res.json(finalResult);
    } catch (err) {
        console.error('Error in /api/analyze:', err);
        res.status(500).json({ error: err.message });
    }
});

// Health check
app.get('/health', (req, res) => { res.json({ status: 'Server is running' }); });

// Global Error Handler
app.use((err, req, res, next) => {
    console.error('Unhandled Error:', err.message);
    res.status(500).json({ error: 'Internal server error: ' + (err.message || 'Unknown'), path: req.url, timestamp: new Date().toISOString() });
});

// 404 Handler
app.use((req, res) => {
    res.status(404).json({ error: 'Route not found: ' + req.url, method: req.method, timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`🔐 Firebase initialized for project: ${firebaseConfig.projectId}`);
    console.log(`💳 Razorpay payment endpoints ready`);
});