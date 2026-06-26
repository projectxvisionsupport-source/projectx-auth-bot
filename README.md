# Project X Vision — Discord Authentication Bot

This is a custom, lightweight Discord Bot and REST API server that replaces KeyAuth. It allows users in your Discord server to claim their license keys via slash commands, and verifies their access by checking if they are still in the server and still hold the required Role.

---

## 1. Environment Variables Needed

When deploying on Render, you must configure the following variables in the **Environment** settings panel:

| Variable Name | Description | How to Get It |
|---|---|---|
| `DISCORD_TOKEN` | Discord Bot token | Developer Portal -> **Bot** tab -> click **Reset Token** and copy. |
| `CLIENT_ID` | Bot Application Client ID | Developer Portal -> **General Information** -> copy **Application ID**. |
| `GUILD_ID` | Your Discord Server ID | Right-click your server icon in Discord -> click **Copy Server ID**. |
| `ROLE_ID` | Role required to run the tool | Server Settings -> **Roles** -> right-click the required role -> click **Copy Role ID**. |

*Note: Make sure **Developer Mode** is enabled in your Discord client settings (App Settings -> Advanced -> Developer Mode) to copy IDs by right-clicking.*

---

## 2. Deploying on Render

1. Commit and push the `discord_auth_bot` folder to GitHub.
2. In the **Render Dashboard**, click **New +** and select **Web Service**.
3. Connect your GitHub repository.
4. Configure the Web Service settings:
   - **Name**: `projectx-auth` (or any name you like)
   - **Root Directory**: `discord_auth_bot`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node bot.js`
5. Click **Advanced**, scroll to **Environment Variables**, and add the four variables listed above.
6. Click **Create Web Service**.

Once deployed, Render will provide you with a public URL, for example:
`https://projectx-auth.onrender.com`

Your C++ application will connect to:
`https://projectx-auth.onrender.com/verify?key=YOUR_KEY`
