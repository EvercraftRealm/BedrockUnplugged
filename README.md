# BedrockUnplugged

![Banner Image](https://www.evercraftmc.com/wp-content/uploads/2026/10/Bedrock-Unplugged-banner.png)

BedrockUnplugged leaves a simulated-player ghost behind when a player disconnects, allowing farms and nearby game systems to continue treating that position as occupied.

The addon safely transfers the player's inventory, armor, offhand, selected hotbar slot, and XP to the ghost. Persistent escrow protects those resources across Realm or server restarts and returns them when the player rejoins.

> BedrockUnplugged is inspired by the concept behind [Unplugged AFK](https://modrinth.com/mod/unplugged-afk) for Java Edition. However, this is an independent implementation built specifically for Minecraft Bedrock and does not use or derive from the original mod's code.

## Compatibility

- Minecraft Bedrock 26.40 or newer
- Realms and Bedrock Dedicated Server
- Beta APIs experiment required
- Not compatible with LAN-hosted worlds because the host cannot be kicked

The addon uses `@minecraft/server-gametest` `1.0.0-beta` to create simulated players. The remaining Script API and server UI dependencies are stable.

## Install

1. Download the `.mcaddon` file from the latest GitHub release.
2. Open it with Minecraft Bedrock Edition.
3. Activate the behavior pack on the world.
4. Enable the Beta APIs experiment.

## Commands

- `/unplug [minutes]` — leave a finite-duration ghost and disconnect.
- `/afk [minutes]` — alias for `/unplug`.
- `/unplugadmin` — open the operator settings and unplug-management menu.

Commands do not require cheats. `/unplugadmin` requires the normal Game Directors/operator permission level.

## Administration

The settings menu controls:

- Whether `/unplug` and `/afk` are enabled.
- Default and maximum unplug duration.
- Unplug name color.
- Damage immunity for newly created unplugs.
- Invisibility for newly created unplugs.
- Automatic unplugging of AFK players and its inactivity threshold.

The management menu distinguishes active, removed, and dead unplugs and allows an operator to remove a selected unplug. Disabling both command unplugging and automatic AFK unplugging intentionally leaves the addon inactive.

## License

BedrockUnplugged is available under the MIT License.
