#!/usr/bin/env node

/**
 * Setup Script: Create Test User for Razorpay Review
 * 
 * Usage: node setup-test-user.js
 * 
 * This script creates a test user account with:
 * - Email: saifact90@gmail.com
 * - Password: Vinay@78
 * - Status: Pro (unlimited access for 1 year)
 */

require('dotenv').config();
const admin = require('firebase-admin');

const testEmail = 'saifact90@gmail.com';
const testPassword = 'Vinay@78';

async function setupTestUser() {
    try {
        console.log('🚀 Starting test user setup...\n');
        console.log('📧 Test Email: ' + testEmail);
        console.log('🔐 Test Password: ' + testPassword);
        console.log('⭐ Status: Pro (1 year access)\n');

        // Initialize Firebase Admin
        try {
            admin.initializeApp({
                projectId: process.env.FIREBASE_PROJECT_ID,
            });
            console.log('✅ Firebase initialized\n');
        } catch (error) {
            console.log('ℹ️  Firebase already initialized\n');
        }

        const db = admin.firestore();
        const auth = admin.auth();

        let uid;

        // Try to create user in Firebase Auth
        try {
            console.log('🔑 Creating user in Firebase Auth...');
            const userRecord = await auth.createUser({
                email: testEmail,
                password: testPassword,
                displayName: 'Razorpay Test User'
            });
            uid = userRecord.uid;
            console.log('✅ User created in Firebase Auth');
            console.log('   UID: ' + uid + '\n');
        } catch (authError) {
            if (authError.code === 'auth/email-already-exists') {
                console.log('⚠️  User already exists in Firebase Auth');
                const userRecord = await auth.getUserByEmail(testEmail);
                uid = userRecord.uid;
                console.log('   Retrieved existing UID: ' + uid + '\n');
            } else {
                throw authError;
            }
        }

        // Create/Update user document in Firestore
        console.log('📝 Creating user document in Firestore...');
        await db.collection('users').doc(uid).set({
            email: testEmail,
            uid: uid,
            displayName: 'Razorpay Test User',
            status: 'Pro',
            credits: 999,
            uploadCount: 0,
            createdAt: new Date().toISOString(),
            expiryDate: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), // 1 year
            testUser: true,
            purpose: 'Razorpay Review',
            createdBy: 'setup-script',
            lastModified: new Date().toISOString()
        }, { merge: true });
        console.log('✅ User document created in Firestore\n');

        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        console.log('✨ TEST USER SETUP COMPLETE!\n');
        console.log('Razorpay team can now login with:');
        console.log('  📧 Email: ' + testEmail);
        console.log('  🔐 Password: ' + testPassword);
        console.log('\n⭐ Features:');
        console.log('  • Pro Member with unlimited access');
        console.log('  • Valid for 365 days');
        console.log('  • Can analyze unlimited thumbnails');
        console.log('  • Can use AI title generator');
        console.log('  • Email/Password login option available\n');
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

        process.exit(0);

    } catch (error) {
        console.error('❌ Error creating test user:', error.message);
        console.error('\n📌 Troubleshooting:');
        console.error('  1. Ensure .env file has FIREBASE_PROJECT_ID');
        console.error('  2. Ensure service account has proper permissions');
        console.error('  3. Check Firebase Console for manual creation');
        process.exit(1);
    }
}

setupTestUser();
