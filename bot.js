const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Environment Configurations ──────────────────────────────────────────────
const TOKEN = process.env.DISCORD_TOKEN;     // Discord Bot Token
const CLIENT_ID = process.env.CLIENT_ID;     // Bot Client ID (Application ID)
const GUILD_ID = process.env.GUILD_ID;       // Your Discord Server ID
const ROLE_ID = process.env.ROLE_ID;         // Role ID required for license (e.g. Member/Vip)
const PORT = process.env.PORT || 3000;       // Web API port

if (!TOKEN || !CLIENT_ID || !GUILD_ID || !ROLE_ID) {
    console.error("ERROR: Missing required environment variables!");
    console.error("Please ensure DISCORD_TOKEN, CLIENT_ID, GUILD_ID, and ROLE_ID are set.");
    process.exit(1);
}

// ─── Database Helpers (Pure JS JSON Database) ───────────────────────────────
const DB_FILE = path.join(__dirname, 'database.json');

function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) {
        fs.writeFileSync(DB_FILE, JSON.stringify({ keys: {} }, null, 2));
    }
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch (e) {
        console.error("Database corrupt, resetting...");
        return { keys: {} };
    }
}

function saveDatabase(db) {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function generateKey() {
    // Generates key like: PXV-XXXX-XXXX-XXXX
    return 'PXV-' + crypto.randomBytes(6).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
}

// ─── Discord Client Setup ───────────────────────────────────────────────────
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds
    ]
});

// ─── Register Slash Commands ────────────────────────────────────────────────
const commands = [
    new SlashCommandBuilder()
        .setName('claimkey')
        .setDescription('Claim your unique Project X Vision license key')
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

client.once('ready', async () => {
    console.log(`[Discord] Bot logged in as ${client.user.tag}`);
    
    try {
        console.log('[Discord] Registering Guild Slash Commands...');
        await rest.put(
            Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
            { body: commands }
        );
        console.log('[Discord] Slash commands registered successfully.');
    } catch (error) {
        console.error('[Discord] Error registering slash commands:', error);
    }
});

// ─── Slash Command Interactions ─────────────────────────────────────────────
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'claimkey') {
        const member = interaction.member;
        
        // 1. Check if user has any of the required roles
        const ROLE_IDS = ROLE_ID.split(',').map(id => id.trim());
        const hasRole = ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
        if (!hasRole) {
            return interaction.reply({
                content: `❌ You do not have the required role to claim a license key.`,
                ephemeral: true
            });
        }

        const db = loadDatabase();
        
        // 2. Check if this user already claimed a key
        let existingKey = null;
        for (const [k, val] of Object.entries(db.keys)) {
            if (val.discordId === member.id) {
                existingKey = k;
                break;
            }
        }

        if (existingKey) {
            return interaction.reply({
                content: `🔑 You already have a license key:\n\`\`\`${existingKey}\`\`\`\nEnter this key in the application's login window.`,
                ephemeral: true
            });
        }

        // 3. Generate new key
        const newKey = generateKey();
        db.keys[newKey] = {
            discordId: member.id,
            created: new Date().toISOString(),
            active: true
        };
        saveDatabase(db);

        return interaction.reply({
            content: `🎉 Your Project X Vision license key has been generated:\n\`\`\`${newKey}\`\`\`\nKeep this key private and enter it in the login window.`,
            ephemeral: true
        });
    }
});

client.login(TOKEN);

// ─── Web API Express Server ────────────────────────────────────────────────
const app = express();

app.get('/verify', async (req, res) => {
    const key = req.query.key;
    if (!key) {
        return res.status(400).json({ success: false, message: "Missing license key parameter." });
    }

    const db = loadDatabase();
    const license = db.keys[key];

    if (!license || !license.active) {
        return res.json({ success: false, message: "Invalid or inactive license key." });
    }

    try {
        // Fetch Guild and Member dynamically in real-time
        const guild = await client.guilds.fetch(GUILD_ID);
        if (!guild) {
            return res.json({ success: false, message: "Server connection failed." });
        }

        const member = await guild.members.fetch(license.discordId).catch(() => null);
        if (!member) {
            return res.json({ success: false, message: "User is no longer in the Discord server." });
        }

        // Check if user still holds any of the required roles
        const ROLE_IDS = ROLE_ID.split(',').map(id => id.trim());
        const hasRole = ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
        if (!hasRole) {
            return res.json({ success: false, message: "Required role was removed or expired." });
        }

        // Access fully granted
        return res.json({ 
            success: true, 
            message: "License validated successfully.",
            username: member.user.username 
        });

    } catch (e) {
        console.error("[API Error] Failed verifying key:", e);
        return res.status(500).json({ success: false, message: "Internal authentication server error." });
    }
});

// Health check endpoint for Render
app.get('/health', (req, res) => {
    res.send('OK');
});

app.listen(PORT, () => {
    console.log(`[API] Web API is listening on port ${PORT}`);
});
