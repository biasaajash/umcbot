const fs = require('fs');
const axios = require('axios');
const { solve } = require('2captcha');
const { AntiCaptcha } = require('anticaptcha');

// Configuration
const CONFIG = {
    captchaService: 'anticaptcha', // 'anticaptcha' or '2captcha'
    apiKeys: {
        '2captcha': 'YOUR_2CAPTCHA_API_KEY',
        'anticaptcha': 'YOUR_ANTICAPTCHA_API_KEY'
    },
    hcaptchaSitekey: '792e708c-cd5a-4380-a378-d596910024fc',
    hcaptchaUrl: 'https://umcoin.org/',
    delays: {
        betweenActions: 15000,
        betweenUsers: 20000,
        afterCaptchaSet: 12000, // Add delay after setting captcha
        afterCloudflareDetection: 60000 // Longer delay after Cloudflare detection
    },
    maxRetries: 15 // Maximum number of retries for failed actions
};

// Read user handles and wallets from files
const users = fs.readFileSync('user.txt', 'utf-8').split('\n').filter(u => u.trim());
const wallets = fs.readFileSync('wallets.txt', 'utf-8').split('\n').filter(w => w.trim());

// Check if we have matching pairs
if (users.length !== wallets.length) {
    console.error('Error: Number of users and wallets must match');
    process.exit(1);
}

const API_URL = 'https://umcoin.org/socialdrop';
const CAPTCHA_URL = 'https://umcoin.org/setcaptcha.php';

// Create axios instance with cookie persistence
const axiosInstance = axios.create();
let cookies = '';

// Intercept responses to collect cookies
axiosInstance.interceptors.response.use(response => {
    const setCookie = response.headers['set-cookie'];
    if (setCookie) {
        // Parse and update cookies
        setCookie.forEach(cookie => {
            const cookiePart = cookie.split(';')[0];
            if (!cookies.includes(cookiePart.split('=')[0])) {
                cookies += (cookies ? '; ' : '') + cookiePart;
            }
        });
    }
    return response;
});

// Helper function to format error responses for better logging
function formatErrorResponse(error) {
    // If there's a response with data
    if (error.response && error.response.data) {
        // If it's HTML content (like Cloudflare errors)
        if (typeof error.response.data === 'string' && error.response.data.includes('<!DOCTYPE html>')) {
            return `HTML response received (likely Cloudflare protection)`;
        }
        // For JSON or other response data, limit the length
        return JSON.stringify(error.response.data).substring(0, 100) + 
               (JSON.stringify(error.response.data).length > 100 ? '...' : '');
    }
    return error.message;
}

// Solve CAPTCHA using selected service
async function solveCaptcha() {
    console.log(`Solving CAPTCHA using ${CONFIG.captchaService}...`);
    
    try {
        let captchaToken;
        
        if (CONFIG.captchaService === '2captcha') {
            const result = await solve({
                apiKey: CONFIG.apiKeys['2captcha'],
                method: 'hcaptcha',
                sitekey: CONFIG.hcaptchaSitekey,
                url: CONFIG.hcaptchaUrl
            });
            captchaToken = result.data;
        } else if (CONFIG.captchaService === 'anticaptcha') {
            const anticaptcha = new AntiCaptcha(CONFIG.apiKeys['anticaptcha']);
            const taskId = await anticaptcha.createTask({
                type: 'HCaptchaTaskProxyless',
                websiteURL: CONFIG.hcaptchaUrl,
                websiteKey: CONFIG.hcaptchaSitekey
            });
            
            const result = await anticaptcha.getTaskResult(taskId);
            captchaToken = result.solution.gRecaptchaResponse;
        } else {
            throw new Error('Invalid CAPTCHA service specified');
        }
        
        // Set CAPTCHA on the server
        const setCaptchaResponse = await axiosInstance.post(CAPTCHA_URL, {
            captcha: captchaToken.toLowerCase() // Ensure lowercase as server seems to expect it
        }, {
            headers: getHeaders()
        });
        
        if (setCaptchaResponse.data.status === 'success' || 
            (setCaptchaResponse.status === 200 && !setCaptchaResponse.data.error)) {
            console.log('CAPTCHA set successfully');
            
            // Wait a bit after setting captcha to ensure it's registered
            await new Promise(resolve => setTimeout(resolve, CONFIG.delays.afterCaptchaSet));
            
            return captchaToken.toLowerCase(); // Return lowercase token
        } else {
            console.error('Failed to set CAPTCHA:', 
                          JSON.stringify(setCaptchaResponse.data).substring(0, 100));
            return null;
        }
    } catch (error) {
        const formattedError = formatErrorResponse(error);
        console.error(`Error solving CAPTCHA: ${error.message}`);
        console.error(`Response summary: ${formattedError}`);
        return null;
    }
}

// Get common headers for requests
function getHeaders() {
    const headers = {
        'Content-Type': 'application/json',
        'Origin': 'https://umcoin.org',
        'Referer': 'https://umcoin.org/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
    };
    
    // Add cookies if available
    if (cookies) {
        headers['Cookie'] = cookies;
    }
    
    return headers;
}

// Check if response indicates Cloudflare protection
function isCloudflareProtection(error) {
    return (
        error.response && 
        error.response.status === 403 && 
        typeof error.response.data === 'string' && 
        (error.response.data.includes('cloudflare') || 
         error.response.data.includes('cf-') || 
         error.response.data.includes('Just a moment'))
    );
}

// Send request to UMCoin API
async function sendRequest(action, handle, wallet) {
    // Try multiple times in case of failure
    for (let attempt = 1; attempt <= CONFIG.maxRetries; attempt++) {
        try {
            // Solve a new CAPTCHA for each request
            const captchaToken = await solveCaptcha();
            if (!captchaToken) {
                console.error(`Failed to get CAPTCHA token for ${action}. Attempt ${attempt}/${CONFIG.maxRetries}`);
                continue;
            }
            
            const payload = {
                action,
                handle: handle.startsWith('@') ? handle : `@${handle}`,
                wallet,
                captcha: captchaToken
            };

            const response = await axiosInstance.post(API_URL, payload, {
                headers: getHeaders()
            });

            if (response.data.status === 'success') {
                console.log(`[${action}] ${handle}: ${response.data.message}`);
                return true;
            } else {
                console.error(`[${action}] ${handle}: Server returned error - ${response.data.message || JSON.stringify(response.data).substring(0, 100)}`);
                // If captcha is incorrect, retry
                if (response.data.message && response.data.message.includes('captcha')) {
                    console.log(`Incorrect captcha detected. Retrying (${attempt}/${CONFIG.maxRetries})...`);
                    continue;
                }
                return false;
            }
        } catch (error) {
            const formattedError = formatErrorResponse(error);
            console.error(`[${action}] ${handle}: Error (Attempt ${attempt}/${CONFIG.maxRetries}) - ${error.message}`);
            console.error(`Response summary: ${formattedError}`);
            
            // Check if it's a Cloudflare protection
            if (isCloudflareProtection(error)) {
                console.log(`Cloudflare protection detected. Waiting longer before retry...`);
                await new Promise(resolve => setTimeout(resolve, CONFIG.delays.afterCloudflareDetection));
            }
            
            // If last attempt, return failure
            if (attempt === CONFIG.maxRetries) {
                return false;
            }
            
            // Wait a bit before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
    
    return false;
}

// Process all actions for a user
async function processUser(user, wallet) {
    console.log(`\nProcessing ${user} with wallet ${wallet}`);
    
    const actions = ['followTwitter', 'followTelegram', 'postTwitter'];
    
    for (const action of actions) {
        const success = await sendRequest(action, user, wallet);
        
        if (success) {
            console.log(`Successfully completed ${action} for ${user}`);
            logToFile(`Successfully completed ${action} for ${user}`);
        } else {
            console.log(`Failed to complete ${action} for ${user} after ${CONFIG.maxRetries} attempts`);
            logToFile(`Failed to complete ${action} for ${user} after ${CONFIG.maxRetries} attempts`);
        }
        
        // Wait between actions
        await new Promise(resolve => setTimeout(resolve, CONFIG.delays.betweenActions));
    }
}

// Create a logger to track progress in a file
function logToFile(message) {
    const timestamp = new Date().toISOString();
    fs.appendFileSync('umcoin_log.txt', `${timestamp}: ${message}\n`);
}

// Process all users
async function processAll() {
    // Create or clear log file
    fs.writeFileSync('umcoin_log.txt', `Started UMCoin social drop process at ${new Date().toISOString()}\n`);
    
    for (let i = 0; i < users.length; i++) {
        const user = users[i].trim();
        const wallet = wallets[i].trim();

        if (!user || !wallet) continue;

        await processUser(user, wallet);
        
        // Log progress
        logToFile(`Processed user ${i+1}/${users.length}: ${user}`);
        
        // Wait between users
        if (i < users.length - 1) {
            await new Promise(resolve => setTimeout(resolve, CONFIG.delays.betweenUsers));
        }
    }
    
    console.log('\nAll users processed!');
    logToFile('All users processed successfully!');
}

// Run the script
processAll().catch(err => {
    console.error('Fatal error:', err.message);
    logToFile(`Fatal error: ${err.message}`);
    process.exit(1);
});
