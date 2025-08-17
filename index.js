const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.MessageContent, 
        GatewayIntentBits.DirectMessages
    ],
    partials: [Partials.Channel] 
});

// Use environment variables instead of hardcoding
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const BOT_TOKEN = process.env.DISCORD_TOKEN;

client.once('ready', () => {
    console.log(`✅ Logged in as ${client.user.tag}`);
});

// Handle !start command
client.on('messageCreate', async message => {
    if (message.content === "!start" && !message.author.bot) {
        try {
            const discordID = message.author.id;
            const dm = await message.author.send("Hi! Please enter your **full name**:");
            const filter = m => m.author.id === message.author.id;
            const collectedName = await dm.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
            const name = collectedName.first().content;

            await dm.channel.send("Please enter your **NXT ID**:");
            const collectedNXT = await dm.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
            const nxtID = collectedNXT.first().content;

            await fetch(GOOGLE_SCRIPT_URL, {
                method: 'POST',
                body: JSON.stringify({ type: "logUser", discordID, name, email: "", nxtID }),
                headers: { 'Content-Type': 'application/json' }
            });

            // Send "I am at office" button
            const row = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('office')
                        .setLabel('I am at office')
                        .setStyle(ButtonStyle.Primary)
                );

            await dm.channel.send({ content: "All set! Click the button when you arrive at the office.", components: [row] });

        } catch (err) {
            console.error(err);
            message.author.send("Something went wrong. Please try again.");
        }
    }
});

// Handle button interaction
client.on('interactionCreate', async interaction => {
    if (!interaction.isButton()) return;
    if (interaction.customId === 'office') {
        await interaction.reply("Please enter the reason for your visit:");
        const filter = m => m.author.id === interaction.user.id;
        const collectedReason = await interaction.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
        const reason = collectedReason.first().content;

        await fetch(GOOGLE_SCRIPT_URL, {
            method: 'POST',
            body: JSON.stringify({ type: "logVisit", date: new Date().toISOString(), discordID: interaction.user.id, reason }),
            headers: { 'Content-Type': 'application/json' }
        });

        await interaction.followUp("✅ Visit logged! Thank you.");
    }
});

client.login(BOT_TOKEN);