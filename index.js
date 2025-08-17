const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');

// Safe fetch: native if exists, otherwise node-fetch
let fetch;
try {
    fetch = global.fetch || require('node-fetch');
} catch (err) {
    fetch = require('node-fetch');
}

// Replit web server for keeping the bot alive
const app = express();
const port = 3000;
app.get('/', (req, res) => {
    res.send('Bot is awake!');
});
app.listen(port, () => {
    console.log(`Web server listening on port ${port}`);
});

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel]
});

// Use environment variables
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const APPROVAL_CHANNEL_ID = process.env.APPROVAL_CHANNEL_ID;
const SCHEDULE_CHANNEL_ID = process.env.SCHEDULE_CHANNEL_ID;

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

// Helper function to handle user onboarding flow
async function onboardUser(user) {
    try {
        const dm = await user.send("Hi! Please enter your **full name**:");
        const filter = m => m.author.id === user.id;

        const collectedName = await dm.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
        const name = collectedName.first().content;

        await dm.channel.send("Please enter your **email address**:");
        const collectedEmail = await dm.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
        const email = collectedEmail.first().content;

        await dm.channel.send("Please enter your **NXT ID**:");
        const collectedNXT = await dm.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
        const nxtID = collectedNXT.first().content;

        await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ type: "logUser", discordID: user.id, name, email, nxtID }),
            headers: { 'Content-Type': 'application/json' }
        });

        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('office')
                    .setLabel('I am at office')
                    .setStyle(ButtonStyle.Primary)
            );

        await user.send({ content: "All set! Click the button when you arrive at the office.", components: [row] });
    } catch (err) {
        console.error("Onboarding failed:", err);
        user.send("Something went wrong with the registration. Please try again.");
    }
}

// Message commands handler
client.on('messageCreate', async message => {
    if (message.author.bot) return;

    // !start command
    if (message.content === "!start") {
        await onboardUser(message.author);
        return;
    }

    // !invite command
    if (message.content.startsWith("!invite")) {
        const usersToInvite = message.content.slice("!invite".length).trim().split(/\s+/);

        for (const username of usersToInvite) {
            const user = client.users.cache.find(u => u.username === username);
            if (user) {
                await user.send("Hi, I will record your Office visit logs from now.");
                const response = await fetch(GOOGLE_SCRIPT_URL, {
                    method: 'POST',
                    body: JSON.stringify({ type: "checkUserExists", discordID: user.id }),
                    headers: { 'Content-Type': 'application/json' }
                });
                const exists = (await response.text()) === "true";
                if (!exists) {
                    await onboardUser(user);
                } else {
                    await user.send("You are already registered.");
                }
            } else {
                await message.channel.send(`Could not find user: ${username}`);
            }
        }
        return;
    }
    
    // !schedule command
    if (message.content.startsWith("!schedule")) {
        const [command, ...args] = message.content.split(/\s+/);
        const onIndex = args.indexOf('on');
        if (onIndex === -1 || onIndex === args.length - 1) {
            return message.channel.send("Invalid schedule format. Use: `!schedule [name] on [date]`");
        }
        const nameToFind = args.slice(0, onIndex).join(' ');
        const dateToSchedule = args.slice(onIndex + 1).join(' ');

        const response = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ type: "findUserByName", name: nameToFind }),
            headers: { 'Content-Type': 'application/json' }
        });
        const matchingUsers = await response.json();

        if (matchingUsers.length === 0) {
            await message.channel.send("No user found with that name.");
        } else if (matchingUsers.length === 1) {
            const user = await client.users.fetch(matchingUsers[0].discordID);
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`schedule_confirm_${user.id}_${dateToSchedule}`).setLabel('I will be there').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`schedule_decline_${user.id}_${dateToSchedule}`).setLabel("I won't be able to make it").setStyle(ButtonStyle.Danger)
                );
            await user.send({ content: `Your office visit is scheduled on **${dateToSchedule}** - Scheduled by **${message.author.username}**.`, components: [row] });
            await message.channel.send(`✅ Scheduled visit for **${user.username}** on **${dateToSchedule}**.`);
        } else {
            const row = new ActionRowBuilder();
            matchingUsers.forEach(user => {
                row.addComponents(
                    new ButtonBuilder().setCustomId(`select_user_${user.discordID}_${dateToSchedule}`).setLabel(user.name).setStyle(ButtonStyle.Secondary)
                );
            });
            await message.channel.send({ content: "Multiple users found. Please select one:", components: [row] });
        }
        return;
    }

    // !approve command
    if (message.channel.id === APPROVAL_CHANNEL_ID && message.content === '!approve') {
        const response = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ type: "getUnapprovedVisits" }),
            headers: { 'Content-Type': 'application/json' }
        });
        const unapprovedVisits = await response.json();

        if (unapprovedVisits.length > 0) {
            const names = unapprovedVisits.map(visit => visit.name);
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId('approve_all').setLabel('Approve All').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId('approve_some').setLabel('Approve Some').setStyle(ButtonStyle.Primary)
                );
            await message.channel.send({ content: `Visits to approve:\n${names.join('\n')}`, components: [row] });
        } else {
            await message.channel.send("No visits to approve at this time.");
        }
    }
});

// Button interactions handler
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    const customId = interaction.customId;

    // "I am at office" button
    if (customId === 'office') {
        await interaction.reply({ content: "What will you do during or what did you do during the visit?", ephemeral: false });
        const filter = m => m.author.id === interaction.user.id;
        try {
            const collectedReason = await interaction.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
            const reason = collectedReason.first().content;
            await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ type: "logVisit", discordID: interaction.user.id, reason }),
                headers: { 'Content-Type': 'application/json' }
            });
            await interaction.followUp("✅ Visit logged! Thank you.");
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId('office').setLabel('I am at office').setStyle(ButtonStyle.Primary)
            );
            await interaction.followUp({ content: "Ready for your next visit? Click the button.", components: [row] });
        } catch (err) {
            await interaction.followUp("Something went wrong. Please try again.");
        }
    }

    // Schedule confirmation buttons
    if (customId.startsWith('schedule_')) {
        const [action, discordID, date] = customId.split('_');
        const scheduleChannel = client.channels.cache.get(SCHEDULE_CHANNEL_ID);
        if (!scheduleChannel) {
            return interaction.reply({ content: "Schedule channel not found. Cannot log.", ephemeral: true });
        }
        const user = interaction.user;
        
        if (action === 'schedule_confirm') {
            await interaction.reply({ content: `Thanks! We have noted that you will be there on **${date}**.`, ephemeral: true });
            await scheduleChannel.send(`✅ **${user.username}** Will be there on **${date}**.`);
            // Log confirmation to Google Sheet
            await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ type: "updateScheduleStatus", discordID, date, status: "Confirmed" }),
                headers: { 'Content-Type': 'application/json' }
            });
        } else if (action === 'schedule_decline') {
            await interaction.reply({ content: "Please tell us why you won't be able to make it:", ephemeral: false });
            const filter = m => m.author.id === interaction.user.id;
            try {
                const collectedReason = await interaction.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
                const reason = collectedReason.first().content;
                await scheduleChannel.send(`❌ **${user.username}** will not be able to make it on **${date}**.\n**Reason:** ${reason}`);
                await interaction.followUp({ content: "Thank you. Your reason has been noted.", ephemeral: true });
                // Log decline to Google Sheet
                await fetch(GOOGLE_SCRIPT_URL, {
                    method: 'POST',
                    body: JSON.stringify({ type: "updateScheduleStatus", discordID, date, status: "Declined", notes: reason }),
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (err) {
                interaction.followUp({ content: "Response timed out. Please try again.", ephemeral: true });
            }
        }
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('office').setLabel('I am at office').setStyle(ButtonStyle.Primary)
        );
        await interaction.followUp({ content: "Click the button when you arrive at the office.", components: [row] });
    }

    // User selection button from !schedule
    if (customId.startsWith('select_user_')) {
        const [_, __, discordID, dateToSchedule] = customId.split('_');
        const user = await client.users.fetch(discordID);
        const row = new ActionRowBuilder()
            .addComponents(
                new ButtonBuilder().setCustomId(`schedule_confirm_${user.id}_${dateToSchedule}`).setLabel('I will be there').setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId(`schedule_decline_${user.id}_${dateToSchedule}`).setLabel("I won't be able to make it").setStyle(ButtonStyle.Danger)
            );
        await user.send({ content: `Your office visit is scheduled on **${dateToSchedule}** - Scheduled by **${interaction.user.username}**.`, components: [row] });
        await interaction.update({ content: `✅ Scheduled visit for **${user.username}** on **${dateToSchedule}**!`, components: [] });
    }

    // Approval buttons
    if (customId === 'approve_all') {
        const response = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ type: "approveAll" }),
            headers: { 'Content-Type': 'application/json' }
        });
        await interaction.update({ content: await response.text(), components: [] });
    }
    
    if (customId === 'approve_some') {
        const response = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ type: "getUnapprovedVisits" }),
            headers: { 'Content-Type': 'application/json' }
        });
        const unapprovedVisits = await response.json();
        
        if (unapprovedVisits.length > 0) {
            const rows = [];
            for (let i = 0; i < unapprovedVisits.length; i += 5) {
                const row = new ActionRowBuilder();
                for (let j = 0; j < 5 && (i + j) < unapprovedVisits.length; j++) {
                    const visit = unapprovedVisits[i + j];
                    row.addComponents(
                        new ButtonBuilder().setCustomId(`approve_single_${visit.discordID}`).setLabel(visit.name).setStyle(ButtonStyle.Success),
                        new ButtonBuilder().setCustomId(`dismiss_single_${visit.discordID}`).setLabel('Dismiss').setStyle(ButtonStyle.Danger)
                    );
                }
                rows.push(row);
            }
            await interaction.update({ content: "Select visits to approve or dismiss:", components: rows });
        } else {
            await interaction.update({ content: "No visits to approve.", components: [] });
        }
    }

    // Single approval/dismissal buttons
    if (customId.startsWith('approve_single_') || customId.startsWith('dismiss_single_')) {
        const [action, _, discordID] = customId.split('_');
        const user = await client.users.fetch(discordID);
        const response = await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ type: action === 'approve_single' ? "approveVisit" : "dismissVisit", discordID }),
            headers: { 'Content-Type': 'application/json' }
        });
        await interaction.reply({ content: `✅ Visit for ${user.username} has been ${action === 'approve_single' ? 'approved' : 'dismissed'}.`, ephemeral: true });
        if (action === 'dismiss_single') {
            await user.send("It appears that you did not come to the office.");
        }
    }
});

client.login(BOT_TOKEN);