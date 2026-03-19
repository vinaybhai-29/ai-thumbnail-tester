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
        console.log('Instance loaded and ready for API calls');
    } catch (error) {
        console.error('❌ FAILED: Error initializing Razorpay SDK');
        console.error('Error Type:', error.constructor.name);
        console.error('Error Message:', error.message);
        console.error('Full Error:', error);
        razorpay = null;
    }
} else {
    console.warn('\n⚠️  WARNING: Razorpay keys not fully configured. Payment routes will NOT work.');
    console.warn('Missing keys:', {
        keyId: !process.env.RAZORPAY_KEY_ID,
        keySecret: !process.env.RAZORPAY_KEY_SECRET
    });
}
console.log('🔑 ===== END RAZORPAY DEBUG =====\n');

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(express.static('.'));

// Endpoint to provide Firebase config to client
app.get('/api/get-firebase-config', (req, res) => {
    res.json(firebaseConfig);
});

// Backend API endpoint for thumbnail analysis
app.post('/api/analyze-thumbnail', async (req, res) => {
    try {
        const { base64, mimeType, uid } = req.body;

        if (!base64 || !mimeType) {
            return res.status(400).json({ error: 'Missing base64 or mimeType' });
        }

        // If uid is provided, validate user exists and check limits
        if (uid) {
            const userDoc = await db.collection('users').doc(uid).get();
            
            if (!userDoc.exists) {
                console.warn(`⚠️ User not found: ${uid}`);
                return res.status(404).json({ error: 'userNotFound', message: 'User not found. Please login first.' });
            }
            
            const userData = userDoc.data();
            // Check if user is Pro member - allow unlimited access
            if (userData.isPro || userData.status === 'Pro') {
                const expiry = userData.expiryDate ? (userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate)) : null;
                if (expiry && new Date() <= expiry) {
                    console.log(`✅ Pro member ${uid} - unlimited thumbnail analysis`);
                    // Pro members get unlimited - continue without upload checks
                } else {
                    // Pro expired, reset status
                    console.log(`⏰ Pro expired for user ${uid}`);
                    await db.collection('users').doc(uid).update({ isPro: false, status: 'free', uploadCount: 0 });
                }
            }

            const testsRemaining = Math.max(0, (userData.credits || 2) - (userData.testsUsedToday || 0));

            if (testsRemaining <= 0 && userData.credits === 0) {
                return res.status(403).json({ error: 'noCredits', message: 'No credits remaining. Please purchase credits.' });
            }
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

        // Update test usage if user is logged in
        if (uid) {
            try {
                const userDoc = await db.collection('users').doc(uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
                    const todayStr = new Date().toDateString();
                    let testsUsedToday = userData.testsUsedToday || 0;
                    
                    // Reset daily count if it's a new day
                    if (userData.lastTestDate !== todayStr) {
                        testsUsedToday = 0;
                    }
                    
                    await db.collection('users').doc(uid).update({
                        testsUsedToday: testsUsedToday + 1,
                        totalTestsUsed: (userData.totalTestsUsed || 0) + 1,
                        lastTestDate: todayStr
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
        const { title, uid } = req.body;

        if (!title || title.trim().length === 0) {
            return res.status(400).json({ error: 'Missing title input' });
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
                    content: `You are a YouTube title expert. Generate 5 catchy, clickable, and SEO-optimized titles based on this input: "${title}". 
                    
Return ONLY a JSON object with a 'titles' array containing exactly 5 title strings. Make them engaging, with power words, and between 40-60 characters. No extra text, no markdown.`
                }]
            })
        });

        const data = await response.json();
        if (data.error) {
            return res.status(400).json({ error: data.error.message });
        }

        const aiText = data.choices[0].message.content.replace(/```json|```/g, '').trim();
        const titles = JSON.parse(aiText);

        res.json(titles);
    } catch (err) {
        console.error('Error generating titles:', err);
        res.status(500).json({ error: err.message });
    }
});

// Combined Analysis (Thumbnail + Title)
app.post('/api/analyze-combined', async (req, res) => {
    try {
        const { base64, mimeType, title, uid } = req.body;

        if (!base64 || !mimeType || !title) {
            return res.status(400).json({ error: 'Missing base64, mimeType, or title' });
        }

        // If uid is provided, validate user exists
        if (uid) {
            const userDoc = await db.collection('users').doc(uid).get();
            
            if (!userDoc.exists) {
                console.warn(`⚠️ User not found for combined analysis: ${uid}`);
                return res.status(404).json({ error: 'userNotFound', message: 'User not found. Please login first.' });
            }
            
            const userData = userDoc.data();
            // Check if user is Pro - allow unlimited combined analysis
            if (userData.isPro || userData.status === 'Pro') {
                const expiry = userData.expiryDate ? (userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate)) : null;
                if (expiry && new Date() <= expiry) {
                    console.log(`✅ Pro member ${uid} - combined analysis unlimited`);
                    // Pro members get unlimited access
                } else {
                    // Pro expired
                    console.log(`⏰ Pro expired for user ${uid}`);
                    await db.collection('users').doc(uid).update({ isPro: false, status: 'free' });
                }
            }
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
                            text: `You are a YouTube expert. Analyze this thumbnail and title TOGETHER for clickability potential.
Title: "${title}"

Return ONLY a JSON object with:
- 'thumbnailScore' (0-100): CTR score for the thumbnail
- 'titleScore' (0-100): Clickability score for the title  
- 'combinedScore' (0-100): Overall combined clickability score
- 'tips' (array of 5 actionable suggestions to improve clicks)
- 'analysis' (2-3 sentences about the thumbnail-title synergy)

No extra text, no markdown.`
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
        const analysis = JSON.parse(aiText);

        // Update usage if user is logged in
        if (uid) {
            try {
                const userDoc = await db.collection('users').doc(uid).get();
                if (userDoc.exists) {
                    const userData = userDoc.data();
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
                }
            } catch (updateErr) {
                console.error('Error updating test usage:', updateErr);
            }
        }

        res.json(analysis);
    } catch (err) {
        console.error('Error in combined analysis:', err);
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

// Diagnostic: Check if Razorpay is initialized
app.get('/api/status', (req, res) => {
    const keyId = process.env.RAZORPAY_KEY_ID;
    const keySecret = process.env.RAZORPAY_KEY_SECRET;
    
    res.json({
        server: 'running',
        razorpayInitialized: !!razorpay,
        razorpayKeyIdSet: !!keyId,
        razorpayKeySecretSet: !!keySecret,
        razorpayKeyId_masked: keyId ? keyId.substring(0, 8) + '...' : 'NOT SET',
        razorpayKeyIdStartsWithRzp: keyId ? keyId.startsWith('rzp_') : false,
        razorpayKeyIdLength: keyId ? keyId.length : 0,
        timestamp: new Date().toISOString(),
        nodeEnv: process.env.NODE_ENV || 'production'
    });
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    // OUTER try-catch to catch ANY error including JSON parsing
    try {
        try {
            const { uid, amount, creditsToAdd } = req.body;

            console.log('\n📋 ===== CREATE ORDER REQUEST =====');
            console.log('Request Data:', { uid, amount, creditsToAdd });

            // Validate input
            if (!uid || !amount || !creditsToAdd) {
                console.warn('⚠️ Validation Error: Missing required fields');
                console.log('Valid fields check:', { uid: !!uid, amount: !!amount, creditsToAdd: !!creditsToAdd });
                return res.status(400).json({ error: 'Missing uid, amount, or creditsToAdd' });
            }

            // Debug environment at request time
            console.log('\n🔍 DEBUG: Environment Check at Order Creation Time');
            console.log('Razorpay instance exists:', !!razorpay);
            console.log('RAZORPAY_KEY_ID set:', !!process.env.RAZORPAY_KEY_ID);
            console.log('RAZORPAY_KEY_SECRET set:', !!process.env.RAZORPAY_KEY_SECRET);
            
            if (process.env.RAZORPAY_KEY_ID) {
                const keyId = process.env.RAZORPAY_KEY_ID;
                console.log('RAZORPAY_KEY_ID value (first 8 chars):', keyId.substring(0, 8));
                console.log('RAZORPAY_KEY_ID length:', keyId.length);
                console.log('Starts with "rzp_":', keyId.startsWith('rzp_'));
            }

            // If Razorpay not initialized, use dummy order for testing
            if (!razorpay) {
                console.warn('\n⚠️  FALLBACK: Razorpay SDK not initialized. Using DUMMY order for UI testing.');
                console.warn('This is expected during development without valid Razorpay keys.');
                
                // Generate a dummy order ID for testing UI
                const dummyOrderId = `order_dummy_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
                const amountInPaise = amount * 100;
                
                console.log('✅ DUMMY ORDER CREATED:', { orderID: dummyOrderId, amount: amountInPaise, currency: 'INR' });
                
                return res.json({
                    orderID: dummyOrderId,
                    currency: 'INR',
                    amount: amountInPaise,
                    isDummy: true,
                    message: 'Dummy order for testing. Configure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET for live payments.'
                });
            }

            // Convert to paise and create order
            const amountInPaise = amount * 100;
            console.log(`\n💰 Creating order: ₹${amount} = ${amountInPaise} paise`);
            console.log('Order Details:', {
                amount: amountInPaise,
                currency: 'INR',
                receipt: `receipt_${uid}_${Date.now()}`,
                uid: uid
            });

            // Make the Razorpay API call
            const order = await razorpay.orders.create({
                amount: amountInPaise,
                currency: 'INR',
                receipt: `receipt_${uid}_${Date.now()}`,
                notes: {
                    uid: uid,
                    creditsToAdd: creditsToAdd
                }
            });

            console.log('✅ SUCCESS: Order Created:', { orderID: order.id, amount: order.amount, currency: order.currency });
            console.log('===== CREATE ORDER SUCCESS =====\n');

            // Return proper JSON response
            return res.status(200).json({
                orderID: order.id,
                currency: order.currency,
                amount: order.amount,
                isDummy: false
            });

        } catch (innerErr) {
            // INNER catch - catches Razorpay SDK errors
            console.error('\n❌ ===== INNER CATCH: ERROR CREATING RAZORPAY ORDER =====');
            console.error('Error Type:', innerErr.constructor.name);
            console.error('Error Message:', innerErr.message);
            console.error('Error Code:', innerErr.code);
            console.error('Error Status:', innerErr.statusCode);
            
            if (innerErr.response) {
                console.error('Razorpay Response Status:', innerErr.response.statusCode);
                console.error('Razorpay Response Body:', innerErr.response.body);
            }
            
            // Extract error message
            let errorMessage = innerErr.message || 'Failed to create Razorpay order';
            
            if (innerErr.response && innerErr.response.body) {
                errorMessage = innerErr.response.body.error?.description || 
                              innerErr.response.body.error?.reason || 
                              errorMessage;
            }
            
            console.error('Final Error Message:', errorMessage);
            console.error('===== END INNER CATCH =====\n');
            
            // Send error response as JSON
            return res.status(500).json({
                error: errorMessage,
                errorCode: innerErr.code || innerErr.statusCode || 'RAZORPAY_ERROR',
                isDummy: false,
                debug: process.env.NODE_ENV === 'development' ? {
                    type: innerErr.constructor.name,
                    statusCode: innerErr.statusCode
                } : undefined
            });
        }
        
    } catch (outerErr) {
        // OUTER catch - catches EVERYTHING (JSON parsing, middleware errors, etc.)
        console.error('\n❌ ===== OUTER CATCH: UNEXPECTED ERROR =====');
        console.error('This indicates a critical server error, not a Razorpay error');
        console.error('Error Type:', outerErr.constructor.name);
        console.error('Error Message:', outerErr.message);
        console.error('Full Stack:', outerErr.stack);
        console.error('===== END OUTER CATCH =====\n');
        
        // ALWAYS send valid JSON response
        return res.status(500).json({
            error: 'Server error: ' + (outerErr.message || 'Unknown error'),
            errorType: 'CRITICAL_SERVER_ERROR',
            isDummy: false
        });
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

        // Update user to Pro status with 28-day expiry
        const expiryDate = new Date();
        expiryDate.setDate(expiryDate.getDate() + 28);

        console.log(`💳 Payment verified for user ${uid}. Setting Pro status, expires: ${expiryDate}`);

        await db.collection('users').doc(uid).update({
            isPro: true,
            status: 'Pro',
            expiryDate: expiryDate,
            lastPaymentDate: new Date(),
            totalPurchases: (userData.totalPurchases || 0) + 1,
            uploadCount: 0
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

// Get User Credits and Usage Status
app.post('/api/get-user-credits', async (req, res) => {
    try {
        const { uid } = req.body;

        if (!uid) {
            return res.status(400).json({ error: 'Missing uid' });
        }

        const userDoc = await db.collection('users').doc(uid).get();
        
        if (!userDoc.exists) {
            // New user
            return res.json({
                status: 'free',
                uploadCount: 0,
                canUpload: true,
                freeTrialsRemaining: 2,
                daysRemaining: 0
            });
        }

        let userData = userDoc.data();
        let currentStatus = userData.status || 'free';
        const uploadCount = userData.uploadCount || 0;
        const freeTrialsRemaining = Math.max(0, 2 - uploadCount);

        // Check if Pro status has expired
        if ((currentStatus === 'Pro' || userData.isPro) && userData.expiryDate) {
            const expiryDate = userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate);
            const now = new Date();

            if (now > expiryDate) {
                // Pro has expired, revert to free
                console.log(`⏰ Pro expired for user ${uid}, reverting to free`);
                currentStatus = 'free';
                await db.collection('users').doc(uid).update({
                    status: 'free',
                    isPro: false,
                    uploadCount: 0
                });
            }
        }

        // Calculate days remaining if Pro
        let daysRemaining = 0;
        if (currentStatus === 'Pro' && userData.expiryDate) {
            const expiryDate = userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate);
            const now = new Date();
            const diffTime = expiryDate - now;
            daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        }

        res.json({
            status: currentStatus,
            uploadCount: uploadCount,
            canUpload: currentStatus === 'Pro' || uploadCount < 2,
            freeTrialsRemaining: freeTrialsRemaining,
            daysRemaining: daysRemaining,
            expiryDate: userData.expiryDate ? (userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate)) : null
        });

    } catch (err) {
        console.error('Error getting user credits:', err);
        res.status(500).json({ error: err.message });
    }
});


// Check Upload Limit (before allowing upload)
app.post('/api/check-upload-limit', async (req, res) => {
    try {
        const { uid } = req.body;

        if (!uid) {
            return res.status(400).json({ error: 'Missing uid' });
        }

        const userDoc = await db.collection('users').doc(uid).get();
        
        if (!userDoc.exists) {
            return res.json({ canUpload: true, isFirstUpload: true });
        }

        let userData = userDoc.data();
        const uploadCount = userData.uploadCount || 0;
        let currentStatus = userData.status || 'free';

        // Check if Pro status has expired
        if (currentStatus === 'Pro' && userData.expiryDate) {
            const expiryDate = userData.expiryDate.toDate ? userData.expiryDate.toDate() : new Date(userData.expiryDate);
            const now = new Date();

            if (now > expiryDate) {
                // Pro has expired, revert to free
                currentStatus = 'free';
                await db.collection('users').doc(uid).update({
                    status: 'free'
                });
            }
        }

        // Pro members can upload unlimited
        if (currentStatus === 'Pro') {
            return res.json({ 
                canUpload: true, 
                status: 'Pro',
                isPro: true
            });
        }

        // Check free user limit
        if (uploadCount >= 2) {
            return res.json({ 
                canUpload: false, 
                uploadCount: uploadCount,
                reason: 'Free limit reached',
                status: 'free'
            });
        }

        res.json({ 
            canUpload: true, 
            uploadCount: uploadCount,
            uploadsRemaining: 2 - uploadCount,
            status: 'free'
        });

    } catch (err) {
        console.error('Error checking upload limit:', err);
        res.status(500).json({ error: err.message });
    }
});

// Increment Upload Count After Analysis
app.post('/api/increment-usage', async (req, res) => {
    try {
        const { uid } = req.body;

        if (!uid) {
            return res.status(400).json({ error: 'Missing uid' });
        }

        const userDoc = await db.collection('users').doc(uid).get();
        
        if (!userDoc.exists) {
            // Create user with first upload
            await db.collection('users').doc(uid).set({
                uploadCount: 1,
                lastUploadDate: new Date(),
                isPremium: false,
                createdAt: new Date()
            });
        } else {
            const userData = userDoc.data();
            const currentCount = userData.uploadCount || 0;
            
            await db.collection('users').doc(uid).update({
                uploadCount: currentCount + 1,
                lastUploadDate: new Date()
            });
        }

        res.json({ success: true });

    } catch (err) {
        console.error('Error incrementing usage:', err);
        res.status(500).json({ error: err.message });
    }
});

// Health check endpoint (must come BEFORE 404 handler)
app.get('/health', (req, res) => {
    res.json({ status: 'Server is running' });
});

// Global Error Handler - Catches ANY unhandled errors from routes
app.use((err, req, res, next) => {
    console.error('\n❌ ===== GLOBAL ERROR HANDLER =====');
    console.error('Unhandled Error caught:', err.message);
    console.error('Error Stack:', err.stack);
    console.error('Request URL:', req.url);
    console.error('Request Method:', req.method);
    console.error('===== END GLOBAL ERROR =====\n');
    
    // Always return valid JSON
    res.status(500).json({
        error: 'Internal server error: ' + (err.message || 'Unknown'),
        path: req.url,
        timestamp: new Date().toISOString()
    });
});

// Create Test User for Razorpay Review
app.post('/api/create-test-user', async (req, res) => {
    try {
        const testEmail = '0vinaychoudhry@gmail.com';
        const testPassword = 'Vinay@78';

        // Check if user already exists in Firestore
        const existingUser = await db.collection('users').where('email', '==', testEmail).get();
        
        if (!existingUser.empty) {
            return res.json({ 
                success: true, 
                message: 'Test user already exists',
                email: testEmail,
                alreadyExists: true
            });
        }

        // Create user in Firebase Auth
        let uid;
        try {
            const userRecord = await admin.auth().createUser({
                email: testEmail,
                password: testPassword,
                displayName: 'Razorpay Test User'
            });
            uid = userRecord.uid;
        } catch (authError) {
            // If user already exists in Auth, get the UID
            if (authError.code === 'auth/email-already-exists') {
                const userRecord = await admin.auth().getUserByEmail(testEmail);
                uid = userRecord.uid;
            } else {
                throw authError;
            }
        }

        // Create user document in Firestore
        await db.collection('users').doc(uid).set({
            email: testEmail,
            uid: uid,
            displayName: 'Razorpay Test User',
            status: 'Pro',
            credits: 999,
            uploadCount: 0,
            createdAt: new Date().toISOString(),
            expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year Pro access
            testUser: true,
            purpose: 'Razorpay Review'
        }, { merge: true });

        console.log('✅ Test user created:', testEmail);

        return res.json({ 
            success: true, 
            message: 'Test user created successfully',
            email: testEmail,
            password: testPassword,
            uid: uid,
            note: 'This test user has unlimited Pro access for 1 year'
        });

    } catch (error) {
        console.error('Error creating test user:', error);
        return res.status(500).json({ 
            error: 'Failed to create test user',
            details: error.message 
        });
    }
});

// TODO: Remove this endpoint before production
// Manual Login Bypass for Razorpay Review
app.post('/api/bypass-login', async (req, res) => {
    try {
        const { email, password } = req.body;

        const testEmail = '0vinaychoudhry@gmail.com';
        const testPassword = 'Vinay@78';

        if (email === testEmail && password === testPassword) {
            const userRecord = await admin.auth().getUserByEmail(testEmail);
            const uid = userRecord.uid;
            
            // Generate a custom token
            const customToken = await admin.auth().createCustomToken(uid);

            return res.json({
                success: true,
                message: 'Bypass successful',
                uid: uid,
                token: customToken
            });
        } else {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
    } catch (error) {
        console.error('Error in bypass-login:', error);
        return res.status(500).json({
            error: 'Failed to bypass login',
            details: error.message
        });
    }
});

// Catch 404 routes and return valid JSON (must come AFTER all real routes)
app.use((req, res) => {
    res.status(404).json({
        error: 'Route not found: ' + req.url,
        method: req.method,
        timestamp: new Date().toISOString()
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
    console.log(`📸 API endpoint: POST http://localhost:${PORT}/api/analyze-thumbnail`);
    console.log(`🔐 Firebase initialized for project: ${firebaseConfig.projectId}`);
    console.log(`💳 Razorpay payment endpoints ready`);
});
