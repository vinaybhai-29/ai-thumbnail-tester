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
console.log('🔑 Razorpay Setup Check:');
console.log('   - RAZORPAY_KEY_ID exists:', !!process.env.RAZORPAY_KEY_ID);
console.log('   - RAZORPAY_KEY_SECRET exists:', !!process.env.RAZORPAY_KEY_SECRET);

if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
    try {
        razorpay = new Razorpay({
            key_id: process.env.RAZORPAY_KEY_ID,
            key_secret: process.env.RAZORPAY_KEY_SECRET
        });
        console.log('✅ Razorpay initialized successfully');
        console.log('   - Key ID starts with:', process.env.RAZORPAY_KEY_ID.substring(0, 8) + '...');
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

            const userData = userDoc.data();
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
    res.json({
        server: 'running',
        razorpayInitialized: !!razorpay,
        razorpayKeyIdSet: !!process.env.RAZORPAY_KEY_ID,
        razorpayKeySecretSet: !!process.env.RAZORPAY_KEY_SECRET,
        timestamp: new Date().toISOString()
    });
});

// Create Razorpay Order
app.post('/api/create-order', async (req, res) => {
    try {
        const { uid, amount, creditsToAdd } = req.body;

        console.log('📋 Create Order Request:', { uid, amount, creditsToAdd });

        if (!uid || !amount || !creditsToAdd) {
            console.warn('⚠️ Validation Error: Missing required fields');
            return res.status(400).json({ error: 'Missing uid, amount, or creditsToAdd' });
        }

        if (!razorpay) {
            console.error('❌ Razorpay not initialized. Check RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET environment variables.');
            return res.status(500).json({ error: 'Razorpay is not initialized. Please ensure RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set in environment variables.' });
        }

        // Convert to paise and create order
        const amountInPaise = amount * 100;
        console.log(`💰 Creating order: ₹${amount} = ${amountInPaise} paise`);

        const order = await razorpay.orders.create({
            amount: amountInPaise,
            currency: 'INR',
            receipt: `receipt_${uid}_${Date.now()}`,
            notes: {
                uid: uid,
                creditsToAdd: creditsToAdd
            }
        });

        console.log('✅ Order Created Successfully:', { orderID: order.id, amount: order.amount, currency: order.currency });

        res.json({
            orderID: order.id,
            currency: order.currency,
            amount: order.amount
        });

    } catch (err) {
        console.error('❌ Error creating Razorpay order:');
        console.error('Error Message:', err.message);
        console.error('Error Code:', err.code);
        console.error('Error Details:', err);
        
        // Return helpful error message
        const errorMessage = err.message || 'Failed to create order with Razorpay';
        res.status(500).json({ 
            error: errorMessage,
            details: process.env.NODE_ENV === 'development' ? err : undefined
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
