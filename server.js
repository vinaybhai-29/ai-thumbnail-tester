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

// Initialize Firebase Admin with service account (if available) or client config
try {
    admin.initializeApp({
        projectId: firebaseConfig.projectId,
    });
} catch (error) {
    console.log('Firebase Admin already initialized or missing service account');
}

const db = admin.firestore();

// Initialize Razorpay - only if keys are available
let razorpay = null;
if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    try {
        razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET
        });
        console.log('✅ Razorpay initialized successfully');
    } catch (error) {
        console.error('❌ Error initializing Razorpay:', error.message);
        razorpay = null;
    }
} else {
    console.warn('⚠️  Warning: Razorpay keys not configured in environment variables. Payment routes will not work.');
}

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('.'));

// Backend API endpoint for thumbnail analysis
app.post('/api/analyze-thumbnail', async (req, res) => {
    try {
        const { base64, mimeType } = req.body;

        if (!base64 || !mimeType) {
            return res.status(400).json({ error: 'Missing base64 or mimeType' });
        }

        const apiKey = process.env.OPENROUTER_API_KEY;
        if (!apiKey) {
            return res.status(500).json({ error: 'API key not configured' });
        }

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
                        {
                            type: 'text',
                            text: "Analyze this YouTube thumbnail for CTR potential. Return ONLY a JSON object with 'score' (0-100 number) and 'tips' (array of exactly 3 improvement tips in English language). No extra text, no markdown."
                        },
                        {
                            type: 'image_url',
                            image_url: { url: `data:${mimeType};base64,${base64}` }
                        }
                    ]
                }]
            })
        });

        const data = await response.json();

        if (data.error) {
            return res.status(400).json({ error: data.error.message });
        }

        const aiText = data.choices[0].message.content.replace(/```json|```/g, '').trim();
        const final = JSON.parse(aiText);

        res.json(final);

    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Save user to Firestore after authentication
app.post('/api/verify-phone-auth', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;

        if (!uid || !email) {
            return res.status(400).json({ error: 'Missing uid or email' });
        }

        // Save user data to Firestore
        await db.collection('users').doc(uid).set({
            email: email,
            displayName: displayName || null,
            createdAt: new Date(),
            testsUsedToday: 0,
            totalTestsUsed: 0,
            lastTestDate: new Date().toDateString(),
            verified: true
        }, { merge: true });

        res.json({ success: true, message: 'User verified and saved' });

    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Get user stats
app.post('/api/get-user-stats', async (req, res) => {
    try {
        const { uid } = req.body;

        if (!uid) {
            return res.status(400).json({ error: 'Missing uid' });
        }

        const userDoc = await db.collection('users').doc(uid).get();
        
        if (!userDoc.exists) {
            return res.json({ testsRemaining: 2, totalUsed: 0 });
        }

        const userData = userDoc.data();
        const todayStr = new Date().toDateString();
        
        // Reset daily count if it's a new day
        let testsUsedToday = userData.testsUsedToday || 0;
        if (userData.lastTestDate !== todayStr) {
            testsUsedToday = 0;
            await db.collection('users').doc(uid).update({
                testsUsedToday: 0,
                lastTestDate: todayStr
            });
        }

        const testsRemaining = Math.max(0, 2 - testsUsedToday);

        res.json({ 
            testsRemaining: testsRemaining,
            testsUsedToday: testsUsedToday,
            totalUsed: userData.totalTestsUsed || 0
        });

    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Update test usage
app.post('/api/update-test-usage', async (req, res) => {
    try {
        const { uid } = req.body;

        if (!uid) {
            return res.status(400).json({ error: 'Missing uid' });
        }

        const userDoc = await db.collection('users').doc(uid).get();
        const userData = userDoc.data() || {};
        const todayStr = new Date().toDateString();

        let testsUsedToday = userData.testsUsedToday || 0;
        if (userData.lastTestDate !== todayStr) {
            testsUsedToday = 0;
        }

        await db.collection('users').doc(uid).update({
            testsUsedToday: testsUsedToday + 1,
            totalTestsUsed: (userData.totalTestsUsed || 0) + 1,
            lastTestDate: todayStr
        });

        res.json({ success: true });

    } catch (err) {
        console.error('Error:', err);
        res.status(500).json({ error: err.message });
    }
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { uid, amount, creditsToAdd } = req.body;

        if (!uid || !amount || !creditsToAdd) {
            return res.status(400).json({ error: 'Missing uid, amount, or creditsToAdd' });
        }

        if (!razorpay) {
            return res.status(500).json({ error: 'Razorpay is not initialized. Please ensure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set in environment variables.' });
        }

        // Create order
        const order = await razorpay.orders.create({
            amount: amount * 100, // Amount in paise
            currency: 'INR',
            receipt: `receipt_${uid}_${Date.now()}`,
            notes: {
                uid: uid,
                creditsToAdd: creditsToAdd
            }
        });

        res.json({
            orderID: order.id,
            currency: order.currency,
            amount: order.amount
        });

    } catch (err) {
        console.error('Error creating Razorpay order:', err);
        res.status(500).json({ error: err.message });
    }
});

// Verify Razorpay Payment
app.post('/api/verify-payment', async (req, res) => {
    try {
        const { uid, razorpay_payment_id, razorpay_order_id, razorpay_signature, creditsToAdd } = req.body;

        if (!uid || !razorpay_payment_id || !razorpay_order_id || !razorpay_signature || !creditsToAdd) {
            return res.status(400).json({ error: 'Missing required payment verification fields' });
        }

        if (!process.env.RAZORPAY_KEY_SECRET) {
            return res.status(500).json({ error: 'Razorpay key secret not configured' });
        }

        // Verify payment signature
        const body = razorpay_order_id + '|' + razorpay_payment_id;
        const expectedSignature = crypto
            .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
            .update(body)
            .digest('hex');

        const isSignatureValid = expectedSignature === razorpay_signature;

        if (!isSignatureValid) {
            return res.status(400).json({ error: 'Payment signature verification failed' });
        }

        // Fetch user data
        const userDoc = await db.collection('users').doc(uid).get();
        
        if (!userDoc.exists) {
            return res.status(404).json({ error: 'User not found' });
        }

        const userData = userDoc.data();
        const currentCredits = userData.credits || 0;

        // Update user credits in Firestore
        await db.collection('users').doc(uid).update({
            credits: currentCredits + creditsToAdd,
            lastCreditPurchaseDate: new Date(),
            totalCreditsPurchased: (userData.totalCreditsPurchased || 0) + creditsToAdd
        });

        // Store payment record for tracking
        await db.collection('users').doc(uid).collection('payments').add({
            razorpay_payment_id: razorpay_payment_id,
            razorpay_order_id: razorpay_order_id,
            creditsAdded: creditsToAdd,
            timestamp: new Date(),
            status: 'completed'
        });

        res.json({ 
            success: true, 
            message: 'Payment verified and credits added',
            newCredits: currentCredits + creditsToAdd
        });

    } catch (err) {
        console.error('Error verifying payment:', err);
        res.status(500).json({ error: err.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📸 API endpoint: POST http://localhost:${PORT}/api/analyze-thumbnail`);
    console.log(`🔐 Firebase initialized for project: ${firebaseConfig.projectId}`);
    console.log(`💳 Razorpay payment endpoints ready`);
});
