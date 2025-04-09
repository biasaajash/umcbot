const fs = require('fs');
const axios = require('axios');

// Read user handles and wallets from files
const users = fs.readFileSync('user.txt', 'utf-8').split('\n').filter(u => u.trim());
const wallets = fs.readFileSync('wallets.txt', 'utf-8').split('\n').filter(w => w.trim());

// Check if we have matching pairs
if (users.length !== wallets.length) {
    console.error('Error: Number of users and wallets must match');
    process.exit(1);
}

const API_URL = 'https://umcoin.org/socialdrop';

async function sendRequest(action, handle, wallet) {
    try {
        const payload = {
            action,
            handle: handle.startsWith('@') ? handle : `@${handle}`,
            wallet
        };

        const response = await axios.post(API_URL, payload, {
            headers: {
                'Content-Type': 'application/json',
                'Origin': 'https://umcoin.org',
                'Referer': 'https://umcoin.org/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36'
            }
        });

        console.log(`[${action}] ${handle}: ${response.data.message}`);
        return true;
    } catch (error) {
        console.error(`[${action}] ${handle}: Error - ${error.message}`);
        return false;
    }
}

async function processAll() {
    for (let i = 0; i < users.length; i++) {
        const user = users[i].trim();
        const wallet = wallets[i].trim();

        if (!user || !wallet) continue;

        console.log(`\nProcessing ${user} with wallet ${wallet}`);

        // Process all actions for each user
        await sendRequest('followTwitter', user, wallet);
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay
        
        await sendRequest('followTelegram', user, wallet);
        await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay
        
        await sendRequest('postTwitter', user, wallet);
        await new Promise(resolve => setTimeout(resolve, 5000)); // 5s delay between users
    }
}

processAll();
