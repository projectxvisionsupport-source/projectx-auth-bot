const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
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

// ─── Database Helpers (MongoDB Atlas Integration) ───────────────────────────
const { MongoClient } = require('mongodb');
const MONGODB_URI = process.env.MONGODB_URI;

let localDb = { keys: {} };
let mongoCollection = null;

async function initDatabase() {
    if (!MONGODB_URI) {
        console.warn("WARNING: MONGODB_URI environment variable not set. Falling back to local database.json!");
        const DB_FILE = path.join(__dirname, 'database.json');
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ keys: {} }, null, 2));
        }
        try {
            localDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (err) {
            localDb = { keys: {} };
        }
        return;
    }
    try {
        console.log("[Database] Connecting to MongoDB...");
        const client = new MongoClient(MONGODB_URI);
        await client.connect();
        const db = client.db('projectx');
        mongoCollection = db.collection('config');
        
        const doc = await mongoCollection.findOne({ _id: 'global_db' });
        if (doc && doc.data) {
            localDb = doc.data;
            console.log("[Database] Loaded database from MongoDB successfully.");
        } else {
            console.log("[Database] No database found in MongoDB. Checking for local database.json migration...");
            const DB_FILE = path.join(__dirname, 'database.json');
            if (fs.existsSync(DB_FILE)) {
                try {
                    localDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
                    console.log("[Database] Migrated local database.json keys to MongoDB.");
                } catch (err) {
                    localDb = { keys: {} };
                }
            } else {
                localDb = { keys: {} };
            }
            await mongoCollection.updateOne({ _id: 'global_db' }, { $set: { data: localDb } }, { upsert: true });
        }
    } catch (e) {
        console.error("[Database] Failed to connect to MongoDB, using local fallback:", e);
        const DB_FILE = path.join(__dirname, 'database.json');
        if (!fs.existsSync(DB_FILE)) {
            fs.writeFileSync(DB_FILE, JSON.stringify({ keys: {} }, null, 2));
        }
        try {
            localDb = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (err) {
            localDb = { keys: {} };
        }
    }
}

function loadDatabase() {
    return localDb;
}

function saveDatabase(db) {
    localDb = db;

    // Save to local file as fallback/backup
    const DB_FILE = path.join(__dirname, 'database.json');
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    } catch (err) {}

    // Save to MongoDB asynchronously
    if (mongoCollection) {
        mongoCollection.updateOne({ _id: 'global_db' }, { $set: { data: db } }, { upsert: true })
            .catch(err => {
                console.error("[Database] Failed to sync to MongoDB:", err);
            });
    }
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
        .setDescription('Reset your registered HWID lock'),
    new SlashCommandBuilder()
        .setName('24hr-keys')
        .setDescription('Generate a batch of 24-hour trial keys (Admin Only)')
        .addIntegerOption(option =>
            option.setName('amount')
                .setDescription('The number of keys to generate (1 - 50)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(50)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('store-setup')
        .setDescription('Post the subscription tier embeds to this channel (Admin Only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('freekey-setup')
        .setDescription('Post the Free Trial Key claim embed to this channel (Admin Only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('checkkey-setup')
        .setDescription('Post the Check Key button embed to this channel (Admin Only)')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
    new SlashCommandBuilder()
        .setName('checkkey')
        .setDescription('Check the status and remaining time on your license key')
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

    // Periodic check for free key pool expiration every 1 minute
    setInterval(async () => {
        try {
            const db = loadDatabase();
            if (db.freePool && db.freePool.expiresAt) {
                const expiresAt = new Date(db.freePool.expiresAt);
                const isExpired = new Date() > expiresAt;
                if (isExpired && !db.freePool.expiredUpdated) {
                    await updateFreeKeyEmbed(client);
                    
                    const updatedDb = loadDatabase();
                    if (updatedDb.freePool) {
                        updatedDb.freePool.expiredUpdated = true;
                        saveDatabase(updatedDb);
                    }
                }
            }
        } catch (err) {
            console.error('[Discord] Error in background expiration checker:', err);
        }
    }, 60000);
});

client.on('interactionCreate', async interaction => {
    if (interaction.isButton()) {
        if (interaction.customId === 'claim_free_key') {
            await handleClaimFreeKey(interaction);
        } else if (interaction.customId === 'check_key_status') {
            await handleCheckKeyStatusButton(interaction);
        }
        return;
    }

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
        let existingIsTrial = false;
        for (const [k, val] of Object.entries(db.keys)) {
            if (val.discordId === member.id) {
                existingKey = k;
                existingIsTrial = !!val.isTrial;
                break;
            }
        }

        if (existingKey && !existingIsTrial) {
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

        if (existingKey && existingIsTrial) {
            // Delete the trial key to make way for the new full key
            delete db.keys[existingKey];
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
    } else if (interaction.commandName === '24hr-keys') {
        // Double-check admin permission just in case
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '❌ Only administrators can generate trial keys.',
                ephemeral: true
            });
        }

        const amount = interaction.options.getInteger('amount');
        const db = loadDatabase();
        
        const keysList = [];
        const now = new Date();
        const expiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);

        // Initialize or reset the free pool
        db.freePool = db.freePool || {};
        db.freePool.keys = [];
        db.freePool.total = amount;
        db.freePool.createdAt = now.toISOString();
        db.freePool.expiresAt = expiresAt.toISOString();
        db.freePool.expiredUpdated = false;

        for (let i = 0; i < amount; i++) {
            const newKey = 'PXV-FREE-' + crypto.randomBytes(4).toString('hex').toUpperCase().match(/.{1,4}/g).join('-');
            db.keys[newKey] = {
                isTrial: true,
                discordId: null, // unclaimed
                created: now.toISOString(),
                expires: null,
                active: true
            };
            db.freePool.keys.push(newKey);
            keysList.push(newKey);
        }
        saveDatabase(db);

        const keysString = keysList.join('\n');

        // Sync the embed counts
        await updateFreeKeyEmbed(interaction.client);

        const embed = new EmbedBuilder()
            .setColor(0xD4163C) // Premium Red
            .setTitle('🏀 Project X Vision | Free Trial Keys Generated')
            .setThumbnail(interaction.client.user.displayAvatarURL())
            .setDescription(`Successfully generated and added **${amount}** keys to the Free Key Section pool. They will expire in 24 hours.`)
            .addFields(
                { name: '📋 Generated Keys', value: `\`\`\`\n${keysString}\n\`\`\`` }
            )
            .setFooter({ text: 'Project X Vision • Admin Panel' })
            .setTimestamp();

        return interaction.reply({
            embeds: [embed],
            ephemeral: true
        });

    } else if (interaction.commandName === 'checkkey-setup') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const channel = interaction.channel;

        const embed = new EmbedBuilder()
            .setColor(0xD4163C)
            .setTitle('🏀 Project X Vision | License Status Check')
            .setThumbnail(interaction.client.user.displayAvatarURL())
            .setDescription('Check the status, expiration date, and registered HWID of your Project X Vision license key at any time.')
            .addFields(
                { name: '📋 Instructions', value: 'Click the button below. The bot will send you a private, ephemeral message with your license details.' }
            )
            .setFooter({ text: 'Project X Vision • Verification Center' })
            .setTimestamp();

        const checkButton = new ButtonBuilder()
            .setCustomId('check_key_status')
            .setLabel('🔍 Check Key Status')
            .setStyle(ButtonStyle.Primary);

        const row = new ActionRowBuilder().addComponents(checkButton);

        await channel.send({ embeds: [embed], components: [row] });

        await interaction.editReply({ content: '✅ License status check embed posted successfully!' });

    } else if (interaction.commandName === 'freekey-setup') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        const channel = interaction.channel;

        const embed = new EmbedBuilder()
            .setColor(0xD4163C)
            .setTitle('Welcome to # 🔑 | FREE!')
            .setThumbnail(interaction.client.user.displayAvatarURL())
            .setDescription('One key per user. Limited stock. Click the button below to claim your 24-hour trial key.')
            .setFooter({ text: 'Project X Vision • Free Keys' })
            .setTimestamp();

        const claimButton = new ButtonBuilder()
            .setCustomId('claim_free_key')
            .setLabel('Generate FREE Key')
            .setStyle(ButtonStyle.Success);

        const remainingButton = new ButtonBuilder()
            .setCustomId('free_keys_remaining')
            .setLabel('Keys remaining 0/0')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

        const row1 = new ActionRowBuilder().addComponents(claimButton);
        const row2 = new ActionRowBuilder().addComponents(remainingButton);

        const message = await channel.send({ embeds: [embed], components: [row1, row2] });

        const db = loadDatabase();
        db.freePool = db.freePool || {};
        db.freePool.channelId = channel.id;
        db.freePool.messageId = message.id;
        saveDatabase(db);

        await updateFreeKeyEmbed(interaction.client);

        await interaction.editReply({ content: '✅ Free Key Section embed posted and linked successfully in this channel!' });

    } else if (interaction.commandName === 'store-setup') {
        if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({ content: '❌ Admin only.', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });

        const STORE_URL = 'https://mee6.gg/m/projectxvision';
        const channel = interaction.channel;

        // ── 1. VIP MEMBERSHIP (Green) ───────────────────────────────────────
        const vipEmbed = new EmbedBuilder()
            .setColor(0x39FF14)
            .setTitle('💚  VIP MEMBERSHIP')
            .setDescription(
                'The perfect entry-level plan to experience AI-assisted timing. ' +
                'Elevate your game with core computer vision features and step-by-step setup guides.\n' +
                '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
            )
            .addFields(
                { name: '⚡  Standard Software Access', value: '> Core features of Project X Vision.', inline: false },
                { name: '🎯  AI Shot Timing', value: '> Real-time meter detection and green release scanning.', inline: false },
                { name: '📋  Setup Guides', value: '> Access to our step-by-step configuration documentation.', inline: false },
                { name: '💬  VIP Discord Role', value: '> Chat with other VIP members and get standard community help.', inline: false },
                { name: '\u200B', value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', inline: false }
            )
            .setFooter({ text: 'Project X Vision • VIP Tier' })
            .setTimestamp();

        const vipButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🛒 Purchase VIP')
                .setStyle(ButtonStyle.Link)
                .setURL(STORE_URL)
        );

        await channel.send({ embeds: [vipEmbed], components: [vipButton] });

        // ── 2. PREMIUM MEMBERSHIP (Blue) ────────────────────────────────────
        const premiumEmbed = new EmbedBuilder()
            .setColor(0x0096FF)
            .setTitle('💎  PREMIUM MEMBERSHIP')
            .setDescription(
                'Experience the standard premium suite of Project X Vision. ' +
                'Get full access to AI-powered green releases and clean ImGui overlay features.\n' +
                '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
            )
            .addFields(
                { name: '⚡  Full Software Access', value: '> Complete usage of the Project X Vision executable.', inline: false },
                { name: '🧠  AI Detection Engine', value: '> Enable YOLOv8 ONNX detection modes.', inline: false },
                { name: '🎮  Hardware Output', value: '> Full controller mapping & Titan Two support.', inline: false },
                { name: '📦  Regular Updates', value: '> Stay up to date with new software patches.', inline: false },
                { name: '🔷  Premium Discord Access', value: '> Unlock standard premium member chat rooms.', inline: false },
                { name: '\u200B', value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', inline: false }
            )
            .setFooter({ text: 'Project X Vision • Premium Tier' })
            .setTimestamp();

        const premiumButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🛒 Purchase Premium')
                .setStyle(ButtonStyle.Link)
                .setURL(STORE_URL)
        );

        await channel.send({ embeds: [premiumEmbed], components: [premiumButton] });

        // ── 3. ELITE MEMBERSHIP (Red) ───────────────────────────────────────
        const eliteEmbed = new EmbedBuilder()
            .setColor(0xD4163C)
            .setTitle('🔴  ELITE MEMBERSHIP')
            .setDescription(
                'Designed for competitive players who want the absolute edge. ' +
                'Unlock the full power of Project X Vision\'s computer vision engine with priority support and elite configurations.\n' +
                '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
            )
            .addFields(
                { name: '⚡  Full Software Access', value: '> Premium usage of the Project X Vision tool.', inline: false },
                { name: '🚀  GPU Acceleration', value: '> High-FPS ONNX detection via OpenCL/CUDA.', inline: false },
                { name: '🎮  Advanced Controller Support', value: '> Seamless Titan Two and virtual controller integration.', inline: false },
                { name: '⏱️  Premium Timing Configs', value: '> Access to community-tested shot timings for layups, rhythmic fades, and dunk meters.', inline: false },
                { name: '🔴  Elite Discord Perks', value: '> Access to Elite discussion rooms and accelerated support ticket queue.', inline: false },
                { name: '\u200B', value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', inline: false }
            )
            .setFooter({ text: 'Project X Vision • Elite Tier' })
            .setTimestamp();

        const eliteButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('🛒 Purchase Elite')
                .setStyle(ButtonStyle.Link)
                .setURL(STORE_URL)
        );

        await channel.send({ embeds: [eliteEmbed], components: [eliteButton] });

        // ── 4. LIFETIME ACCESS (Gold) ───────────────────────────────────────
        const lifetimeEmbed = new EmbedBuilder()
            .setColor(0xFFD700)
            .setTitle('👑  LIFETIME ACCESS')
            .setDescription(
                'Get permanent, unrestricted access to Project X Vision with a single, one-time payment. ' +
                'Never worry about monthly subscriptions or billing cycles again.\n' +
                '\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
            )
            .addFields(
                { name: '🏆  Permanent Software License', value: '> Lifetime access to all current and future Project X Vision releases.', inline: false },
                { name: '🧠  Full AI Model Access', value: '> Unrestricted use of ONNX GPU-accelerated neural networks (including the latest Arrow2 models).', inline: false },
                { name: '🎮  Zero-Latency Controller Emulation', value: '> Direct hardware-level output support for Titan Two and ViGEm.', inline: false },
                { name: '🔄  Lifetime Updates', value: '> Automatic updates for new game seasons, patches, and feature additions.', inline: false },
                { name: '👑  Elite Lifetime Discord Role', value: '> Access to private lifetime-only channels, exclusive timings sharing, and priority support.', inline: false },
                { name: '\u200B', value: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', inline: false }
            )
            .setFooter({ text: 'Project X Vision • Lifetime Tier' })
            .setTimestamp();

        const lifetimeButton = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setLabel('👑 Purchase Lifetime')
                .setStyle(ButtonStyle.Link)
                .setURL(STORE_URL)
        );

        await channel.send({ embeds: [lifetimeEmbed], components: [lifetimeButton] });

        await interaction.editReply({ content: '✅ Store embeds posted successfully in this channel!' });

    } else if (interaction.commandName === 'checkkey') {
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
                content: '❌ You do not have an active license key.',
                ephemeral: true
            });
        }

        const created = new Date(license.created);
        const hwidStatus = license.hwid ? `\`${license.hwid.substring(0, 8)}...\`` : '🔓 Not locked yet';
        let timeInfo = '♾️ Lifetime (No Expiration)';

        if (license.isTrial) {
            if (license.expires) {
                const expireDate = new Date(license.expires);
                const now = new Date();
                const remaining = expireDate - now;
                if (remaining <= 0) {
                    timeInfo = '❌ **Expired**';
                } else {
                    const hours = Math.floor(remaining / (60 * 60 * 1000));
                    const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
                    timeInfo = `⏳ **${hours}h ${minutes}m** remaining`;
                }
            } else {
                timeInfo = '⏳ 24 hours (activates on first use)';
            }
        }

        const embed = new EmbedBuilder()
            .setColor(license.isTrial ? 0x2A2A30 : 0xD4163C)
            .setTitle('🏀 Project X Vision | License Status')
            .setThumbnail(interaction.client.user.displayAvatarURL())
            .addFields(
                { name: '🔑 License Key', value: `\`\`\`${userKey}\`\`\``, inline: false },
                { name: '📅 Created', value: `<t:${Math.floor(created.getTime() / 1000)}:F>`, inline: true },
                { name: '⏱️ Time Remaining', value: timeInfo, inline: true },
                { name: '🖥️ HWID Lock', value: hwidStatus, inline: true },
                { name: '📋 Type', value: license.isTrial ? '24-Hour Trial' : 'Full License', inline: true },
                { name: '✅ Status', value: license.active ? '🟢 Active' : '🔴 Inactive', inline: true }
            )
            .setFooter({ text: 'Project X Vision • License Info' })
            .setTimestamp();

        return interaction.reply({
            embeds: [embed],
            ephemeral: true
        });
    }
});

// ─── Free Key Claim & Update Handlers ───────────────────────────────────────
async function handleCheckKeyStatusButton(interaction) {
    await interaction.deferReply({ ephemeral: true });

    const db = loadDatabase();
    const userId = interaction.user.id;

    let userKey = null;
    let license = null;
    for (const [k, val] of Object.entries(db.keys)) {
        if (val.discordId === userId) {
            userKey = k;
            license = val;
            break;
        }
    }

    if (!userKey) {
        return interaction.editReply({
            content: '❌ You do not have an active license key. Please purchase one in the store or claim a free trial key.'
        });
    }

    const created = new Date(license.created);
    const hwidStatus = license.hwid ? `\`${license.hwid.substring(0, 8)}...\`` : '🔓 Not locked yet';
    let timeInfo = '♾️ Lifetime (No Expiration)';

    if (license.isTrial) {
        if (license.expires) {
            const expireDate = new Date(license.expires);
            const now = new Date();
            const remaining = expireDate - now;
            if (remaining <= 0) {
                timeInfo = '❌ **Expired**';
            } else {
                const hours = Math.floor(remaining / (60 * 60 * 1000));
                const minutes = Math.floor((remaining % (60 * 60 * 1000)) / (60 * 1000));
                timeInfo = `⏳ **${hours}h ${minutes}m** remaining`;
            }
        } else {
            timeInfo = '⏳ 24 hours (activates on first use)';
        }
    }

    const embed = new EmbedBuilder()
        .setColor(license.isTrial ? 0x2A2A30 : 0xD4163C)
        .setTitle('🏀 Project X Vision | License Status')
        .setThumbnail(interaction.client.user.displayAvatarURL())
        .addFields(
            { name: '🔑 License Key', value: `\`\`\`${userKey}\`\`\``, inline: false },
            { name: '📅 Created', value: `<t:${Math.floor(created.getTime() / 1000)}:F>`, inline: true },
            { name: '⏱️ Time Remaining', value: timeInfo, inline: true },
            { name: '🖥️ HWID Lock', value: hwidStatus, inline: true },
            { name: '📋 Type', value: license.isTrial ? '24-Hour Trial' : 'Full License', inline: true },
            { name: '✅ Status', value: license.active ? '🟢 Active' : '🔴 Inactive', inline: true }
        )
        .setFooter({ text: 'Project X Vision • License Info' })
        .setTimestamp();

    return interaction.editReply({
        embeds: [embed]
    });
}

async function handleClaimFreeKey(interaction) {
    await interaction.deferReply({ ephemeral: true });
    
    // 1. Check if user has an active subscription role on Discord
    const ROLE_IDS = ROLE_ID.split(',').map(id => id.trim());
    const member = interaction.member;
    if (member) {
        const hasSubRole = ROLE_IDS.some(roleId => member.roles.cache.has(roleId));
        if (hasSubRole) {
            return interaction.editReply({ content: '❌ You have an active subscription role. You do not need a trial key.' });
        }
    }

    const db = loadDatabase();
    
    if (!db.freePool || !db.freePool.expiresAt) {
        return interaction.editReply({ content: '❌ Free key pool is not active or set up.' });
    }

    const expiresAt = new Date(db.freePool.expiresAt);
    const isExpired = new Date() > expiresAt;
    
    if (isExpired || !db.freePool.keys || db.freePool.keys.length === 0) {
        await updateFreeKeyEmbed(interaction.client);
        return interaction.editReply({ content: '❌ The free key pool has expired or all keys have been claimed.' });
    }

    // 2. Check if the user already has an active trial key
    const hasActiveTrial = Object.values(db.keys).some(k => k.discordId === interaction.user.id && k.isTrial);
    if (hasActiveTrial) {
        return interaction.editReply({ content: '❌ You have already claimed a free trial key. Limit 1 trial key per user.' });
    }

    // 3. Remove any old inactive full keys for this user to keep their entry unique
    for (const [k, val] of Object.entries(db.keys)) {
        if (val.discordId === interaction.user.id && !val.isTrial) {
            delete db.keys[k];
        }
    }

    // Pop a key from the pool
    const claimedKey = db.freePool.keys.shift();
    
    // Assign to user in database
    if (db.keys[claimedKey]) {
        db.keys[claimedKey].discordId = interaction.user.id;
        db.keys[claimedKey].created = new Date().toISOString();
    }
    
    saveDatabase(db);

    // Sync channel embed
    await updateFreeKeyEmbed(interaction.client);

    // Send the key to the claiming user
    const keyEmbed = new EmbedBuilder()
        .setColor(0xD4163C) // Premium Red
        .setTitle('🏀 Project X Vision | Free Trial Key Claimed')
        .setThumbnail(interaction.client.user.displayAvatarURL())
        .setDescription('Your 24-hour Project X Vision trial key has been successfully claimed!')
        .addFields(
            { name: '🔑 Your Trial Key', value: `\`\`\`${claimedKey}\`\`\`` },
            { name: '⏱️ Duration', value: 'Lasts **24 hours** from your **first login** inside the app.' },
            { name: '🚀 How to Activate', value: '1. Open the application.\n2. Paste this key into the login window.\n3. Click **ACTIVATE LICENSE**.' }
        )
        .setFooter({ text: 'Project X Vision • Game On' })
        .setTimestamp();

    return interaction.editReply({
        embeds: [keyEmbed]
    });
}

async function updateFreeKeyEmbed(client) {
    const db = loadDatabase();
    if (!db.freePool || !db.freePool.channelId || !db.freePool.messageId) {
        return;
    }

    try {
        const channel = await client.channels.fetch(db.freePool.channelId);
        if (!channel) return;

        const message = await messageFetchSafely(channel, db.freePool.messageId);
        if (!message) return;

        const expiresAt = db.freePool.expiresAt ? new Date(db.freePool.expiresAt) : null;
        const isExpired = expiresAt ? (new Date() > expiresAt) : true;
        const total = isExpired ? 0 : (db.freePool.total || 0);
        const remaining = isExpired ? 0 : (db.freePool.keys ? db.freePool.keys.length : 0);

        const embed = new EmbedBuilder()
            .setColor(0xD4163C)
            .setTitle('Welcome to # 🔑 | FREE!')
            .setThumbnail(client.user.displayAvatarURL())
            .setDescription('One key per user. Limited stock. Click the button below to claim your 24-hour trial key.')
            .setFooter({ text: 'Project X Vision • Free Keys' })
            .setTimestamp();

        const claimButton = new ButtonBuilder()
            .setCustomId('claim_free_key')
            .setLabel('Generate FREE Key')
            .setStyle(ButtonStyle.Success)
            .setDisabled(remaining === 0);

        const remainingButton = new ButtonBuilder()
            .setCustomId('free_keys_remaining')
            .setLabel(`Keys remaining ${remaining}/${total}`)
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(true);

        const row1 = new ActionRowBuilder().addComponents(claimButton);
        const row2 = new ActionRowBuilder().addComponents(remainingButton);

        await message.edit({ embeds: [embed], components: [row1, row2] });
    } catch (error) {
        console.error('[Discord] Failed to update free key embed:', error);
    }
}

// Safe message fetch helper to prevent crash on deletion
async function messageFetchSafely(channel, messageId) {
    try {
        return await channel.messages.fetch(messageId);
    } catch (e) {
        return null;
    }
}

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

    // Trial Key Logic (Bypasses role validation, locked to 24 hours from first use)
    if (license.isTrial) {
        // Enforce 1 trial key per machine: check if this HWID already activated a different trial key
        if (!license.hwid) {
            for (const [existingKey, existingLicense] of Object.entries(db.keys)) {
                if (existingKey !== key && existingLicense.isTrial && existingLicense.hwid === hwid) {
                    return res.json({ success: false, message: "This machine has already used a trial key. Only 1 trial per device is allowed." });
                }
            }
        }

        // HWID Locking Logic
        if (!license.hwid) {
            license.hwid = hwid;
            saveDatabase(db);
        } else if (license.hwid !== hwid) {
            return res.json({ success: false, message: "HWID mismatch. Trial keys are locked to one PC." });
        }

        const now = new Date();
        if (license.expires) {
            const expireDate = new Date(license.expires);
            if (now > expireDate) {
                return res.json({ success: false, message: "This 24-hour trial key has expired." });
            }
        } else {
            // First time activation: set expiration to 24 hours from now
            const expireDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
            license.expires = expireDate.toISOString();
            saveDatabase(db);
        }

        return res.json({ 
            success: true, 
            message: "Trial license validated successfully.",
            username: "Trial User",
            expires: license.expires
        });
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

async function start() {
    await initDatabase();
    client.login(TOKEN);
    app.listen(PORT, () => {
        console.log(`[API] Web API is listening on port ${PORT}`);
    });
}
start();
