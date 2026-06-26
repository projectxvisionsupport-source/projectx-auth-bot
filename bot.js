const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder } = require('discord.js');
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
        .setDescription('Claim your unique Project X Vision license key'),
    new SlashCommandBuilder()
        .setName('resethwid')
        .setDescription('Reset your registered HWID lock')
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
            const embed = new EmbedBuilder()
                .setColor(0x2A2A30) // Sleek dark grey/black
                .setTitle('🏀 Project X Vision | License Active')
                .setThumbnail(interaction.client.user.displayAvatarURL())
                .setDescription('You have already claimed a license key for this season.')
                .addFields(
                    { name: '📋 License Key', value: `\`\`\`${existingKey}\`\`\`` },
                    { name: '📥 Instructions', value: 'Paste this key into the application\'s login window to bypass the lock and enter the court.' }
                )
                .setFooter({ text: 'Project X Vision • Secure Authentication' })
                .setTimestamp();

            return interaction.reply({
                embeds: [embed],
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

        const embed = new EmbedBuilder()
            .setColor(0xD4163C) // Premium Red Accent matching the app
            .setTitle('🏀 Project X Vision | License Generated')
            .setThumbnail(interaction.client.user.displayAvatarURL())
            .setDescription('Your Project X Vision AI license has been generated successfully!')
            .addFields(
                { name: '🔑 Your License Key', value: `\`\`\`${newKey}\`\`\`` },
                { name: '⚠️ Security Rule', value: 'This license is bound to your HWID. Sharing your key is strictly prohibited and will result in an automated ban.' },
                { name: '🚀 How to Start', value: '1. Open the application folder.\n2. Run `ProjectXVision.exe`.\n3. Paste this key into the login window and click **ACTIVATE LICENSE**.' }
            )
            .setFooter({ text: 'Project X Vision • Powered by AI' })
            .setTimestamp();

        return interaction.reply({
            embeds: [embed],
            ephemeral: true
        });
    } else if (interaction.commandName === 'resethwid') {
        const member = interaction.member;
        const db = loadDatabase();
        
        let userKey = null;
        let license = null;
        for (const [k, val] of Object.entries(db.keys)) {
            if (val.discordId === member.id) {
                userKey = k;
                license = val;
                break;
            }
        }

        if (!userKey) {
            return interaction.reply({
                content: '❌ You do not have an active license key to reset.',
                ephemeral: true
            });
        }

        if (!license.hwid) {
            return interaction.reply({
                content: 'ℹ️ Your license key is already unlocked (no HWID is registered yet).',
                ephemeral: true
            });
        }

        // Cooldown Check (Once every 24 hours)
        const now = new Date();
        if (license.lastReset) {
            const lastResetDate = new Date(license.lastReset);
            const diffMs = now - lastResetDate;
            const cooldownMs = 24 * 60 * 60 * 1000; // 24 hours
            
            if (diffMs < cooldownMs) {
                const remainingMs = cooldownMs - diffMs;
                const remainingHours = Math.floor(remainingMs / (60 * 60 * 1000));
                const remainingMinutes = Math.floor((remainingMs % (60 * 60 * 1000)) / (60 * 1000));
                
                const cooldownEmbed = new EmbedBuilder()
                    .setColor(0x2A2A30) // Dark Grey
                    .setTitle('🏀 Project X Vision | Reset Cooldown')
                    .setThumbnail(interaction.client.user.displayAvatarURL())
                    .setDescription(`❌ You can only reset your HWID lock once every 24 hours.`)
                    .addFields(
                        { name: '⏳ Cooldown Remaining', value: `\`${remainingHours}h ${remainingMinutes}m\`` },
                        { name: '💡 Note', value: 'This safety feature prevents key sharing. If you have a legitimate emergency, contact an administrator.' }
                    )
                    .setFooter({ text: 'Project X Vision • Cooldown Protection' })
                    .setTimestamp();

                return interaction.reply({
                    embeds: [cooldownEmbed],
                    ephemeral: true
                });
            }
        }

        // Clear the registered HWID
        license.hwid = null;
        license.lastReset = now.toISOString();
        saveDatabase(db);

        const embed = new EmbedBuilder()
            .setColor(0xD4163C) // Premium Red
            .setTitle('🏀 Project X Vision | HWID Reset Success')
            .setThumbnail(interaction.client.user.displayAvatarURL())
            .setDescription('Your HWID lock has been successfully cleared!')
            .addFields(
                { name: '📋 License Key', value: `\`\`\`${userKey}\`\`\`` },
                { name: '💡 Next Step', value: 'Start `ProjectXVision.exe` on your new computer and activate the key. It will lock to the new system automatically.' }
            )
            .setFooter({ text: 'Project X Vision • HWID Management' })
            .setTimestamp();

        return interaction.reply({
            embeds: [embed],
            ephemeral: true
        });
    }
});

client.login(TOKEN);

// ─── Web API Express Server ────────────────────────────────────────────────
const app = express();

app.get('/verify', async (req, res) => {
    const key = req.query.key;
    const hwid = req.query.hwid;
    if (!key || !hwid) {
        return res.status(400).json({ success: false, message: "Missing license key or HWID parameter." });
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

        // HWID Locking Logic
        if (!license.hwid) {
            license.hwid = hwid;
            saveDatabase(db);
        } else if (license.hwid !== hwid) {
            return res.json({ success: false, message: "HWID mismatch. Use /resethwid in Discord to switch PCs." });
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
