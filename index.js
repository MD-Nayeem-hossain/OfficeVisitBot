const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');
const http = require('http');

// Safe fetch implementation
let fetch;
try {
  fetch = global.fetch || require('node-fetch');
} catch (err) {
  fetch = require('node-fetch');
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Channel, Partials.Message]
});

// Environment variables
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const BOT_TOKEN = process.env.DISCORD_TOKEN;
const PENDING_VISITS = new Map();
const PENDING_APPROVALS = new Map();
const PENDING_SCHEDULES = new Map();

// Keep Replit alive
const server = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type': 'text/plain'});
  res.end('Bot is active');
});
server.listen(3000, () => console.log('✅ Keep-alive server running on port 3000'));

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  
  // Ping every 5 minutes to prevent sleep
  setInterval(() => {
    if (process.env.REPL_HEALTHCHECK) {
      fetch(process.env.REPL_HEALTHCHECK)
        .then(() => console.log('🟢 Pinged keep-alive'))
        .catch(console.error);
    }
  }, 5 * 60 * 1000);
});

// Handle !start command
async function startRegistration(user) {
  try {
    const discordID = user.id;
    const dm = await user.send("Hi! Please enter your **full name**:");
    const filter = m => m.author.id === user.id;

    const collectedName = await dm.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
    const name = collectedName.first().content;

    await dm.channel.send("Please enter your **NXT ID**:");
    const collectedNXT = await dm.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
    const nxtID = collectedNXT.first().content;

    await dm.channel.send("Please enter your **email**:");
    const collectedEmail = await dm.channel.awaitMessages({ filter, max: 1, time: 60000, errors: ['time'] });
    const email = collectedEmail.first().content;

    // Send user info to Google Apps Script
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ type: "logUser", discordID, name, email, nxtID }),
      headers: { 'Content-Type': 'application/json' }
    });

    // Send office button
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('office')
        .setLabel('I am at office')
        .setStyle(ButtonStyle.Primary)
    );

    await dm.channel.send({ 
      content: "✅ Registration complete! Click below when you arrive:",
      components: [row] 
    });

  } catch (err) {
    console.error(err);
    user.send("❌ Registration timed out or failed. Use !start to try again.");
  }
}

// Handle !invite command
client.on('messageCreate', async message => {
  // Start command
  if (message.content === "!start" && !message.author.bot) {
    await startRegistration(message.author);
  }
  
  // Invite command
  if (message.content.startsWith('!invite') && message.guild) {
    if (!message.member.permissions.has('ADMINISTRATOR')) {
      return message.reply("❌ You need administrator permissions to use this command.");
    }

    const users = message.content.split(' ').slice(1);
    if (users.length === 0) return message.reply("Please mention users after !invite");

    for (const username of users) {
      try {
        const member = await message.guild.members.fetch({ 
          query: username.replace('@', ''), 
          limit: 1 
        }).then(m => m.first());
        
        if (member) {
          await member.send("Hi, I will record your Office visit logs from now");
          await startRegistration(member.user);
          message.reply(`✅ Invite sent to ${member.user.username}`);
        }
      } catch (err) {
        console.error(`Failed to invite ${username}:`, err);
      }
    }
  }
  
  // Schedule command
  if (message.content.startsWith('!schedule') && message.channel.name === 'schedule') {
    const args = message.content.split(' ');
    if (args.length < 3) return message.reply("Usage: !schedule [name] [dd/mm/yy]");
    
    const [_, name, date] = args;
    const scheduleDate = new Date(date.split('/').reverse().join('-'));
    
    // Fetch possible matches
    const response = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ type: "findUsers", name }),
      headers: { 'Content-Type': 'application/json' }
    });
    
    const users = await response.json().catch(() => []);
    
    if (!users || users.length === 0) {
      return message.reply("❌ No matching users found");
    }
    
    if (users.length === 1) {
      await confirmSchedule(message, users[0], scheduleDate);
    } else {
      // Create selection buttons
      const row = new ActionRowBuilder();
      users.forEach((user, index) => {
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`schedule_${user.discordID}`)
            .setLabel(user.name)
            .setStyle(ButtonStyle.Secondary)
        );
      });
      
      const embed = new EmbedBuilder()
        .setTitle("Multiple users found")
        .setDescription("Select the correct user:")
        .setColor(0x3498db);
      
      const reply = await message.reply({ 
        embeds: [embed], 
        components: [row] 
      });
      
      PENDING_SCHEDULES.set(reply.id, { 
        original: message, 
        users, 
        date: scheduleDate 
      });
    }
  }
});

// Handle all interactions
client.on('interactionCreate', async interaction => {
  // Office check-in button
  if (interaction.isButton() && interaction.customId === 'office') {
    await handleOfficeCheckin(interaction);
  }
  
  // Schedule selection buttons
  if (interaction.isButton() && interaction.customId.startsWith('schedule_')) {
    const discordID = interaction.customId.split('_')[1];
    const scheduleData = PENDING_SCHEDULES.get(interaction.message.id);
    
    if (scheduleData) {
      const user = scheduleData.users.find(u => u.discordID === discordID);
      await confirmSchedule(scheduleData.original, user, scheduleData.date);
      await interaction.update({ components: [] }); // Remove buttons
      PENDING_SCHEDULES.delete(interaction.message.id);
    }
  }
  
  // Approval system
  if (interaction.isButton() && interaction.customId.startsWith('approve_')) {
    await handleApproval(interaction);
  }
  
  // Schedule response buttons
  if (interaction.isButton() && interaction.customId === 'confirm_attendance') {
    await interaction.reply({ content: "✅ Thank you for confirming!", flags: ['EPHEMERAL'] });
    const channel = client.channels.cache.find(c => c.name === 'schedule');
    if (channel) {
      channel.send(`**${interaction.user.username}** will be attending as scheduled`);
    }
  }
  
  if (interaction.isButton() && interaction.customId === 'decline_attendance') {
    await interaction.reply({ 
      content: "Please provide a reason why you can't make it:", 
      flags: ['EPHEMERAL'] 
    });
    const filter = m => m.author.id === interaction.user.id;
    const collected = await interaction.channel.awaitMessages({ filter, max: 1, time: 60000 });
    const reason = collected.first().content;
    
    const channel = client.channels.cache.find(c => c.name === 'schedule');
    if (channel) {
      channel.send(`**${interaction.user.username}** can't attend: ${reason}`);
    }
    await interaction.followUp({ 
      content: "❌ Your absence has been noted. Thank you for informing us.", 
      flags: ['EPHEMERAL'] 
    });
  }
});

async function handleOfficeCheckin(interaction) {
  try {
    await interaction.deferReply({ flags: ['EPHEMERAL'] });
    
    // Get user info
    const userRes = await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({ type: "getUser", discordID: interaction.user.id }),
      headers: { 'Content-Type': 'application/json' }
    });
    
    const userText = await userRes.text();
    let userData;
    try {
      userData = JSON.parse(userText);
    } catch {
      userData = null;
    }
    
    if (!userData || !userData.name) {
      return interaction.editReply("❌ Complete registration with !start first");
    }
    
    // Store pending visit
    PENDING_VISITS.set(interaction.user.id, {
      name: userData.name,
      discordID: interaction.user.id,
      timestamp: new Date().toISOString()
    });
    
    // Ask for visit reason
    await interaction.editReply("Please describe what you'll do during your visit:");
    
    // Collect reason
    const filter = m => m.author.id === interaction.user.id;
    const collectedReason = await interaction.channel.awaitMessages({ 
      filter, 
      max: 1, 
      time: 60000 
    });
    
    const reason = collectedReason.first().content;
    const visitData = PENDING_VISITS.get(interaction.user.id);
    visitData.reason = reason;
    
    // Notify approval channel
    const approvalChannel = client.channels.cache.find(
      c => c.name === "approval" && c.type === "GUILD_TEXT"
    );
    
    if (approvalChannel) {
      const embed = new EmbedBuilder()
        .setTitle("Visit Approval Needed")
        .setDescription(`${visitData.name} checked in at ${new Date().toLocaleTimeString()}`)
        .addFields({ name: "Reason", value: reason })
        .setColor(0xf1c40f);
      
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('approve_all')
          .setLabel('Approve All')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('approve_select')
          .setLabel('Approve Select')
          .setStyle(ButtonStyle.Primary)
      );
      
      await approvalChannel.send({ 
        embeds: [embed], 
        components: [row],
        content: "**New visit requires approval**" 
      });
      
      await interaction.editReply("✅ Check-in complete! Your visit is pending approval.");
      
      // Re-show office button
      const officeBtn = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId('office')
          .setLabel('I am at office')
          .setStyle(ButtonStyle.Primary)
      );
      
      await interaction.followUp({ 
        content: "Check in again when you return:", 
        components: [officeBtn] 
      });
    } else {
      throw new Error("Approval channel not found");
    }
    
  } catch (err) {
    console.error(err);
    interaction.editReply("❌ Check-in failed: " + err.message);
  }
}

async function handleApproval(interaction) {
  await interaction.deferReply({ flags: ['EPHEMERAL'] });
  
  if (interaction.customId === 'approve_all') {
    // Approve all pending visits
    for (const [userId, visit] of PENDING_VISITS) {
      await logVisitToSheet(visit);
      PENDING_VISITS.delete(userId);
    }
    await interaction.editReply("✅ All visits approved");
  } 
  else if (interaction.customId === 'approve_select') {
    // Show individual approval options
    const embed = new EmbedBuilder()
      .setTitle("Select Visits to Approve")
      .setColor(0x3498db);
    
    const rows = [];
    let currentRow = new ActionRowBuilder();
    
    // Add buttons for each pending visit
    let count = 0;
    PENDING_VISITS.forEach((visit, userId) => {
      if (count > 0 && count % 5 === 0) {
        rows.push(currentRow);
        currentRow = new ActionRowBuilder();
      }
      currentRow.addComponents(
        new ButtonBuilder()
          .setCustomId(`approve_${userId}`)
          .setLabel(`Approve ${visit.name}`)
          .setStyle(ButtonStyle.Success)
      );
      count++;
    });
    if (currentRow.components.length > 0) rows.push(currentRow);
    
    await interaction.editReply({ 
      embeds: [embed], 
      components: rows 
    });
  }
  else if (interaction.customId.startsWith('approve_')) {
    const userId = interaction.customId.split('_')[1];
    const visit = PENDING_VISITS.get(userId);
    
    if (visit) {
      // Log approved visit
      await logVisitToSheet(visit);
      
      // Remove from pending
      PENDING_VISITS.delete(userId);
      await interaction.editReply(`✅ Approved ${visit.name}'s visit`);
    } else {
      await interaction.editReply("❌ Visit not found or already approved");
    }
  }
}

async function logVisitToSheet(visitData) {
  await fetch(GOOGLE_SCRIPT_URL, {
    method: 'POST',
    body: JSON.stringify({ 
      type: "logVisit", 
      timestamp: visitData.timestamp,
      discordID: visitData.discordID,
      name: visitData.name,
      reason: visitData.reason
    }),
    headers: { 'Content-Type': 'application/json' }
  });
}

async function confirmSchedule(originalMessage, user, date) {
  try {
    // Notify user
    const member = await originalMessage.guild.members.fetch(user.discordID);
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_attendance')
        .setLabel('I will be there')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('decline_attendance')
        .setLabel("I can't make it")
        .setStyle(ButtonStyle.Danger)
    );
    
    const embed = new EmbedBuilder()
      .setTitle("Office Visit Scheduled")
      .setDescription(`You're scheduled for ${date.toDateString()}`)
      .setFooter({ text: `Scheduled by ${originalMessage.author.username}` })
      .setColor(0x2ecc71);
    
    await member.send({ 
      embeds: [embed], 
      components: [row] 
    });
    
    // Log to Google Sheet
    await fetch(GOOGLE_SCRIPT_URL, {
      method: 'POST',
      body: JSON.stringify({
        type: "logSchedule",
        dateTime: date.toISOString(),
        employeeDiscordID: user.discordID,
        employeeName: user.name,
        bookedBy: originalMessage.author.username
      }),
      headers: { 'Content-Type': 'application/json' }
    });
    
    await originalMessage.reply(`✅ Scheduled ${user.name} for ${date.toDateString()}`);
    
  } catch (err) {
    console.error("Scheduling error:", err);
    originalMessage.reply(`❌ Failed to schedule ${user.name}: ${err.message}`);
  }
}

client.login(BOT_TOKEN);