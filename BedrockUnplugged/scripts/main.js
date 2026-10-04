import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  EquipmentSlot,
  GameMode,
  system,
  world,
} from "@minecraft/server";
import * as GameTest from "@minecraft/server-gametest";
import {
  ActionFormData,
  MessageFormData,
  ModalFormData,
} from "@minecraft/server-ui";

const BOT_TAG = "bedrockunplugged.bot";
const LEGACY_BOT_TAG = "unplugged_afk.bot";
const LOOK_INTERVAL_TICKS = 10;
const SESSION_LEDGER_PROPERTY = "afk:session_ledger";
const CONFIG_PROPERTY = "afk:config";
const ESCROW_TYPE = "afk:escrow";
const ESCROW_EQUIPMENT_OFFSET = 36;
const CAMERA_ACTIVITY_EPSILON = 0.1;
const NAME_COLORS = [
  ["Black", "0"],
  ["Dark Blue", "1"],
  ["Dark Green", "2"],
  ["Dark Aqua", "3"],
  ["Dark Red", "4"],
  ["Dark Purple", "5"],
  ["Gold", "6"],
  ["Gray", "7"],
  ["Dark Gray", "8"],
  ["Blue", "9"],
  ["Green", "a"],
  ["Aqua", "b"],
  ["Red", "c"],
  ["Light Purple", "d"],
  ["Yellow", "e"],
  ["White", "f"],
];
const RESTART_PLACEHOLDER_SKIN = {
  armSize: GameTest.PersonaArmSize.Wide,
  personaPieces: [],
  skinColor: { red: 0.5, green: 0.5, blue: 0.5 },
};
const sessionsByOwner = new Map();
const afkTrackingSessions = new Map();
let config = {
  configVersion: 5,
  defaultTimeoutMinutes: 129600,
  maxTimeoutMinutes: 129600,
  nameColorCode: "7",
  disableDamage: false,
  hidePlayers: false,
  unplugCommandEnabled: true,
  unplugAfkPlayers: false,
  afkThresholdMinutes: 5,
};
const EQUIPMENT_SLOTS = [
  EquipmentSlot.Head,
  EquipmentSlot.Chest,
  EquipmentSlot.Legs,
  EquipmentSlot.Feet,
  EquipmentSlot.Offhand,
];
const DEATH_CAUSE_TEXT = {
  anvil: "a falling anvil",
  blockExplosion: "a block explosion",
  campfire: "a campfire",
  contact: "contact damage",
  drowning: "drowning",
  entityAttack: "an entity attack",
  entityExplosion: "an entity explosion",
  fall: "fall damage",
  fallingBlock: "a falling block",
  fire: "fire",
  fireTick: "burning",
  fireworks: "fireworks",
  flyIntoWall: "flying into a wall",
  freezing: "freezing",
  lava: "lava",
  lightning: "lightning",
  maceSmash: "a mace smash",
  magic: "magic",
  magma: "a magma block",
  piston: "a piston",
  projectile: "a projectile",
  ramAttack: "a ram attack",
  selfDestruct: "the kill command",
  sonicBoom: "a sonic boom",
  soulCampfire: "a soul campfire",
  stalactite: "a falling stalactite",
  stalagmite: "a stalagmite",
  starve: "starvation",
  suffocation: "suffocation",
  temperature: "temperature damage",
  thorns: "thorns",
  void: "the void",
  wither: "the Wither effect",
};

function ownerKey(name) {
  return name.trim().toLowerCase();
}

function isUnplugBot(player) {
  return player.hasTag(BOT_TAG) || player.hasTag(LEGACY_BOT_TAG);
}

function formatDurationMinutes(totalMinutes) {
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  return [
    [days, "day"],
    [hours, "hour"],
    [minutes, "minute"],
  ]
    .filter(([value]) => value > 0)
    .map(([value, unit]) => `${value} ${unit}${value === 1 ? "" : "s"}`)
    .join(", ");
}

function cameraMoved(previous, current) {
  return (
    Math.abs(previous.x - current.x) >= CAMERA_ACTIVITY_EPSILON ||
    Math.abs(previous.y - current.y) >= CAMERA_ACTIVITY_EPSILON
  );
}

function tell(player, message) {
  player.sendMessage(`[BedrockUnplugged] ${message}`);
}

function broadcast(message) {
  world.sendMessage(`[BedrockUnplugged] ${message}`);
}

function describeError(error) {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

function readableEntityName(entity) {
  if (!entity) return undefined;
  try {
    if (entity.nameTag) return entity.nameTag;
    return entity.typeId.replace(/^minecraft:/, "").replace(/_/g, " ");
  } catch {
    return undefined;
  }
}

function describeDeath(damageSource) {
  const cause = damageSource?.cause ?? "unknown";
  const causeText = DEATH_CAUSE_TEXT[cause] ?? cause;
  const attacker = readableEntityName(damageSource?.damagingEntity);
  const projectile = readableEntityName(damageSource?.damagingProjectile);

  if (attacker) {
    if (cause === "projectile") return `was shot by ${attacker}`;
    if (cause === "entityExplosion") return `was blown up by ${attacker}`;
    return `was killed by ${attacker}`;
  }
  if (projectile) return `was killed by ${projectile}`;

  const concise = {
    drowning: "drowned",
    fall: "fell to their death",
    fire: "burned to death",
    fireTick: "burned to death",
    freezing: "froze to death",
    lava: "died in lava",
    selfDestruct: "was killed",
    starve: "starved",
    suffocation: "suffocated",
    void: "fell into the void",
  };
  return concise[cause] ?? `died from ${causeText}`;
}

function readableDimensionName(dimensionId) {
  const id = String(dimensionId ?? "").replace(/^minecraft:/, "");
  if (id === "overworld") return "the Overworld";
  if (id === "nether") return "the Nether";
  if (id === "the_end") return "the End";
  return id.replace(/_/g, " ");
}

function requirePlayer(origin) {
  const source = origin.sourceEntity;
  if (!source || source.typeId !== "minecraft:player") return undefined;
  return source;
}

function failure(message) {
  return { status: CustomCommandStatus.Failure, message };
}

function success(message) {
  return { status: CustomCommandStatus.Success, message };
}

function ensureGameTestApi(player) {
  if (typeof GameTest.spawnSimulatedPlayer === "function") return true;
  tell(
    player,
    `This GameTest module does not export spawnSimulatedPlayer. Exports: ${Object.keys(GameTest).join(", ")}`,
  );
  return false;
}

function coloredName(playerName, colorCode = config.nameColorCode) {
  return `\u00a7${colorCode}${playerName}\u00a7r`;
}

function applyBotOptions(bot, session) {
  if (session.disableDamage) {
    bot.setGameMode(GameMode.creative);
    bot.addEffect("resistance", 20000000, { amplifier: 255, showParticles: false });
  } else {
    bot.setGameMode(GameMode.survival);
  }
  if (session.hidePlayers) {
    bot.addEffect("invisibility", 20000000, { showParticles: false });
    bot.nameTag = "";
  }
}

function persistentSessionData(session) {
  return {
    ownerName: session.ownerName,
    botName: session.botName,
    nameColorCode: session.nameColorCode,
    createdAt: session.createdAt,
    botDied: Boolean(session.botDied),
    botRemoved: Boolean(session.botRemoved),
    interruptionReason: session.interruptionReason,
    deathReason: session.deathReason,
    deathLocation: session.deathLocation,
    deathDimension: session.deathDimension,
    expectedResources: session.expectedResources,
    escrowId: session.escrowId,
    escrowLocation: session.escrowLocation,
    escrowDimension: session.escrowDimension,
    escrowXp: session.escrowXp,
    escrowSelectedSlotIndex: session.escrowSelectedSlotIndex,
    escrowToken: session.escrowToken,
    expiresAt: session.expiresAt,
    disableDamage: Boolean(session.disableDamage),
    hidePlayers: Boolean(session.hidePlayers),
  };
}

function saveConfig() {
  world.setDynamicProperty(CONFIG_PROPERTY, JSON.stringify(config));
}

function loadConfig() {
  const stored = world.getDynamicProperty(CONFIG_PROPERTY);
  if (typeof stored !== "string") return;
  try {
    const loaded = JSON.parse(stored);
    const loadedTimeout = Math.floor(Number(loaded.defaultTimeoutMinutes) || 129600);
    const maxTimeoutMinutes = Math.max(
      1,
      Math.floor(Number(loaded.maxTimeoutMinutes) || 129600),
    );
    const migratedTimeout =
      loaded.configVersion === undefined && loadedTimeout === 60
        ? 129600
        : (loaded.configVersion ?? 0) < 3 && loadedTimeout === 1440
          ? 129600
          : loadedTimeout;
    config = {
      configVersion: 5,
      defaultTimeoutMinutes: Math.min(maxTimeoutMinutes, Math.max(1, migratedTimeout)),
      maxTimeoutMinutes,
      nameColorCode: NAME_COLORS.some(([, code]) => code === loaded.nameColorCode)
        ? loaded.nameColorCode
        : "7",
      disableDamage: Boolean(loaded.disableDamage),
      hidePlayers: Boolean(loaded.hidePlayers),
      unplugCommandEnabled:
        loaded.unplugCommandEnabled === undefined
          ? true
          : Boolean(loaded.unplugCommandEnabled),
      unplugAfkPlayers: Boolean(loaded.unplugAfkPlayers),
      afkThresholdMinutes: Math.max(
        1,
        Math.floor(Number(loaded.afkThresholdMinutes) || 5),
      ),
    };
  } catch {}
}

function summarizeSnapshot(snapshot) {
  let stacks = 0;
  let items = 0;
  for (const item of snapshot.inventory) {
    if (!item) continue;
    stacks++;
    items += item.amount;
  }
  for (const item of snapshot.equipment.values()) {
    if (!item) continue;
    stacks++;
    items += item.amount;
  }
  return { stacks, items, totalXp: snapshot.totalXp };
}

function saveSessionLedger() {
  const sessions = [...sessionsByOwner.values()]
    .filter((session) => session.persistent)
    .map(persistentSessionData);
  world.setDynamicProperty(SESSION_LEDGER_PROPERTY, JSON.stringify(sessions));
}

function loadSessionLedger() {
  const stored = world.getDynamicProperty(SESSION_LEDGER_PROPERTY);
  if (typeof stored !== "string" || stored.length === 0) return;

  let records;
  try {
    records = JSON.parse(stored);
  } catch (error) {
    console.error(`[BedrockUnplugged] Session ledger is invalid: ${describeError(error)}`);
    return;
  }
  if (!Array.isArray(records)) return;

  const connectedBots = world
    .getAllPlayers()
    .filter(isUnplugBot);
  for (const record of records) {
    if (!record?.ownerName || !record?.botName) continue;
    const bot = connectedBots.find((candidate) => candidate.name === record.botName);
    const session = {
      ...record,
      ownerId: undefined,
      bot,
      botId: bot?.id,
      inventoryCommitted: !record.botDied,
      persistent: true,
      expiresAt:
        record.expiresAt ?? Date.now() + config.defaultTimeoutMinutes * 60000,
      restartDisconnected: !bot && !record.botDied && !record.botRemoved,
    };
    sessionsByOwner.set(ownerKey(record.ownerName), session);
    try {
      findEscrow(session);
    } catch {}
  }
}

function getInventoryContainer(player) {
  const component = player.getComponent("minecraft:inventory");
  if (!component?.container) {
    throw new Error(`${player.name} has no accessible inventory container`);
  }
  return component.container;
}

function getEquippable(player) {
  const component = player.getComponent("minecraft:equippable");
  if (!component) {
    throw new Error(`${player.name} has no accessible equippable component`);
  }
  return component;
}

function getEscrowContainer(escrow) {
  const component = escrow?.getComponent("minecraft:inventory");
  if (!component?.container || component.container.size < 41) {
    throw new Error("AFK escrow inventory is unavailable");
  }
  return component.container;
}

function writeEscrowSnapshot(session, snapshot) {
  const container = getEscrowContainer(session.escrow);
  container.clearAll();
  for (let slot = 0; slot < snapshot.inventory.length; slot++) {
    container.setItem(slot, snapshot.inventory[slot]);
  }
  for (let index = 0; index < EQUIPMENT_SLOTS.length; index++) {
    container.setItem(
      ESCROW_EQUIPMENT_OFFSET + index,
      snapshot.equipment.get(EQUIPMENT_SLOTS[index]),
    );
  }
  session.escrowXp = snapshot.totalXp;
  session.escrowSelectedSlotIndex = snapshot.selectedSlotIndex;
  session.expectedResources = summarizeSnapshot(snapshot);
}

function captureEscrowSnapshot(session) {
  const container = getEscrowContainer(session.escrow);
  const inventory = [];
  for (let slot = 0; slot < 36; slot++) inventory.push(container.getItem(slot));

  const equipment = new Map();
  for (let index = 0; index < EQUIPMENT_SLOTS.length; index++) {
    equipment.set(
      EQUIPMENT_SLOTS[index],
      container.getItem(ESCROW_EQUIPMENT_OFFSET + index),
    );
  }
  return {
    inventory,
    equipment,
    selectedSlotIndex: session.escrowSelectedSlotIndex ?? 0,
    totalXp: session.escrowXp ?? 0,
  };
}

function createEscrow(session, snapshot) {
  const bot = session.bot;
  const escrow = bot.dimension.spawnEntity(ESCROW_TYPE, bot.location);
  session.escrowToken = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  escrow.addTag(`afk_escrow_${session.escrowToken}`);
  session.escrow = escrow;
  session.escrowId = escrow.id;
  session.escrowLocation = { ...escrow.location };
  session.escrowDimension = escrow.dimension.id;
  writeEscrowSnapshot(session, snapshot);
}

function findEscrow(session) {
  if (session.escrow) return session.escrow;
  if (session.escrowId) {
    const byId = world.getEntity(session.escrowId);
    if (byId?.typeId === ESCROW_TYPE) {
      session.escrow = byId;
      return byId;
    }
  }
  if (!session.escrowLocation || !session.escrowDimension || !session.escrowToken) {
    return undefined;
  }
  const dimension = world.getDimension(session.escrowDimension);
  const nearby = dimension.getEntities({
    type: ESCROW_TYPE,
    tags: [`afk_escrow_${session.escrowToken}`],
    location: session.escrowLocation,
    maxDistance: 2,
  })[0];
  if (nearby) {
    session.escrow = nearby;
    session.escrowId = nearby.id;
  }
  return nearby;
}

function removeEscrow(session) {
  try {
    const escrow = findEscrow(session);
    if (escrow) escrow.remove();
  } catch (error) {
    console.warn(
      `[BedrockUnplugged] Could not remove ${session.ownerName}'s escrow: ${describeError(error)}`,
    );
  }
  session.escrow = undefined;
  session.escrowId = undefined;
}

function restoreBotAfterRestart(session) {
  if (session.bot || session.botDied || session.botRemoved) return;
  if (Date.now() >= session.expiresAt) {
    session.botRemoved = true;
    session.interruptionReason ??= "timeout";
    saveSessionLedger();
    return;
  }
  if (!session.escrowLocation || !session.escrowDimension) {
    throw new Error("escrow location is unavailable");
  }
  const dimension = world.getDimension(session.escrowDimension);
  const location = session.escrowLocation;
  const bot = GameTest.spawnSimulatedPlayer(
    { dimension, x: location.x, y: location.y, z: location.z },
    session.botName,
    GameMode.spectator,
  );
  try {
    bot.setSkin(RESTART_PLACEHOLDER_SKIN);
  } catch (error) {
    console.warn(
      `[BedrockUnplugged] Could not apply the restart placeholder skin for ${session.ownerName}: ${describeError(error)}`,
    );
  }
  bot.addTag(BOT_TAG);
  bot.nameTag = coloredName(session.ownerName, session.nameColorCode ?? "7");
  session.bot = bot;
  session.botId = bot.id;
  session.restoring = true;

  system.runTimeout(() => {
    try {
      if (sessionsByOwner.get(ownerKey(session.ownerName)) !== session) return;
      if (!findEscrow(session)) throw new Error("escrow entity did not load");
      applyInventory(bot, captureEscrowSnapshot(session));
      applyBotOptions(bot, session);
      session.inventoryCommitted = true;
      session.restartDisconnected = false;
      session.restoring = false;
      saveSessionLedger();
    } catch (error) {
      try {
        bot.disconnect();
      } catch {}
      session.bot = undefined;
      session.botId = undefined;
      session.restoring = false;
      console.error(
        `[BedrockUnplugged] Could not finish restoring ${session.ownerName}'s unplug: ${describeError(error)}`,
      );
    }
  }, 20);
}

function captureInventory(player) {
  const container = getInventoryContainer(player);
  const equippable = getEquippable(player);
  const inventory = [];

  for (let slot = 0; slot < container.size; slot++) {
    inventory.push(container.getItem(slot));
  }

  const equipment = new Map();
  for (const slot of EQUIPMENT_SLOTS) {
    equipment.set(slot, equippable.getEquipment(slot));
  }

  return {
    inventory,
    equipment,
    selectedSlotIndex: player.selectedSlotIndex,
    totalXp: player.getTotalXp(),
  };
}

function clearInventory(player) {
  const container = getInventoryContainer(player);
  const equippable = getEquippable(player);

  for (let slot = 0; slot < container.size; slot++) {
    container.setItem(slot);
  }
  for (const slot of EQUIPMENT_SLOTS) {
    equippable.setEquipment(slot);
  }
  player.resetLevel();
}

function applyInventory(player, snapshot) {
  const container = getInventoryContainer(player);
  const equippable = getEquippable(player);
  if (container.size < snapshot.inventory.length) {
    throw new Error(
      `Target inventory has ${container.size} slots; ${snapshot.inventory.length} are required`,
    );
  }

  clearInventory(player);
  for (let slot = 0; slot < snapshot.inventory.length; slot++) {
    container.setItem(slot, snapshot.inventory[slot]);
  }
  for (const slot of EQUIPMENT_SLOTS) {
    equippable.setEquipment(slot, snapshot.equipment.get(slot));
  }
  player.selectedSlotIndex = snapshot.selectedSlotIndex;
  if (snapshot.totalXp > 0) player.addExperience(snapshot.totalXp);
}

function stageOwnerInventory(owner, session) {
  const snapshot = captureInventory(owner);
  try {
    clearInventory(owner);
  } catch (error) {
    try {
      applyInventory(owner, snapshot);
    } catch (rollbackError) {
      console.error(
        `[BedrockUnplugged] Inventory rollback failed for ${owner.name}: ${describeError(rollbackError)}`,
      );
    }
    throw error;
  }

  session.inventorySnapshot = snapshot;
  session.inventoryCommitted = false;
}

function commitInventoryToBot(session) {
  if (!session.inventorySnapshot || session.inventoryCommitted) return;
  session.expectedResources = summarizeSnapshot(session.inventorySnapshot);
  createEscrow(session, session.inventorySnapshot);
  applyInventory(session.bot, session.inventorySnapshot);
  session.inventoryCommitted = true;
  session.inventorySnapshot = undefined;
}

function restoreStagedInventory(owner, session) {
  if (!session.inventorySnapshot || session.inventoryCommitted) return;
  applyInventory(owner, session.inventorySnapshot);
  session.inventorySnapshot = undefined;
}

function restoreSessionInventoryToOwner(owner, session) {
  if (session.inventoryCommitted) {
    const botInventory = captureInventory(session.bot);
    applyInventory(owner, botInventory);
    clearInventory(session.bot);
    session.inventoryCommitted = false;
    return;
  }
  restoreStagedInventory(owner, session);
}

function parkSessionForReturn(session, interruptionReason) {
  try {
    if (session.escrow) writeEscrowSnapshot(session, captureInventory(session.bot));
    session.bot.disconnect();
  } catch (error) {
    throw new Error(`Could not disconnect ${session.ownerName}'s bot: ${describeError(error)}`);
  }
  session.bot = undefined;
  session.botRemoved = true;
  if (interruptionReason === "admin") session.interruptionReason = interruptionReason;
  else session.interruptionReason ??= interruptionReason;
  saveSessionLedger();
}

function returnPlayerToSpawn(player) {
  const personalSpawn = player.getSpawnPoint();
  if (personalSpawn) {
    player.teleport(personalSpawn, { dimension: personalSpawn.dimension });
    return;
  }

  const dimension = world.getDimension("overworld");
  const defaultSpawn = world.getDefaultSpawnLocation();
  let location = defaultSpawn;

  if (defaultSpawn.y > dimension.heightRange.max) {
    const topBlock = dimension.getTopmostBlock({
      x: Math.floor(defaultSpawn.x),
      z: Math.floor(defaultSpawn.z),
    });
    if (topBlock) {
      location = {
        x: topBlock.location.x + 0.5,
        y: topBlock.location.y + 1,
        z: topBlock.location.z + 0.5,
      };
    }
  }

  player.teleport(location, { dimension });
}

function spawnOwnedBot(owner) {
  if (!ensureGameTestApi(owner)) return undefined;

  const key = ownerKey(owner.name);
  if (sessionsByOwner.has(key)) {
    tell(owner, "An unplugged session already exists for this account.");
    return undefined;
  }

  const rotation = owner.getRotation();
  const location = {
    dimension: owner.dimension,
    x: owner.location.x,
    y: owner.location.y,
    z: owner.location.z,
  };

  const bot = GameTest.spawnSimulatedPlayer(
    location,
    coloredName(owner.name),
    GameMode.survival,
  );

  bot.addTag(BOT_TAG);
  bot.addTag(`bedrockunplugged_owner_${owner.id}`);
  bot.setRotation(rotation);
  bot.nameTag = coloredName(owner.name);

  try {
    if (typeof GameTest.getPlayerSkin !== "function") {
      throw new Error("The loaded GameTest module does not export getPlayerSkin");
    }
    bot.setSkin(GameTest.getPlayerSkin(owner));
  } catch (error) {
    tell(owner, `Bot spawned, but skin copying failed: ${describeError(error)}`);
  }

  const session = {
    ownerId: owner.id,
    ownerName: owner.name,
    bot,
    botId: bot.id,
    botName: bot.name,
    nameColorCode: config.nameColorCode,
    createdAt: Date.now(),
  };
  sessionsByOwner.set(key, session);
  return session;
}

function removeSession(key, reason, announce = true) {
  const session = sessionsByOwner.get(key);
  if (!session) return false;

  try {
    if (session.bot) session.bot.remove();
  } catch (error) {
    console.warn(
      `[BedrockUnplugged] Could not remove bot for ${session.ownerName}: ${describeError(error)}`,
    );
  }

  removeEscrow(session);

  sessionsByOwner.delete(key);
  saveSessionLedger();
  if (announce) broadcast(`${session.ownerName}'s AFK bot was removed (${reason}).`);
  return true;
}

function isRealOwnerConnected(session) {
  return world.getAllPlayers().some((player) => player.id === session.ownerId);
}

function rollbackFailedDisconnect(owner, session, error) {
  const key = ownerKey(session.ownerName);
  if (sessionsByOwner.get(key) !== session) return;

  try {
    restoreSessionInventoryToOwner(owner, session);
  } catch (rollbackError) {
    console.error(
      `[BedrockUnplugged] Kick-failure inventory rollback failed for ${session.ownerName}: ${describeError(rollbackError)}`,
    );
  }
  removeSession(key, "disconnect command failed", false);
  try {
    tell(owner, "The host cannot unplug!");
  } catch {}
  console.warn(
    `[BedrockUnplugged] Could not disconnect ${session.ownerName}; the session was rolled back${error ? `: ${describeError(error)}` : "."}`,
  );
}

function beginUnplug(owner, timeoutMinutes = config.defaultTimeoutMinutes) {
  let session;
  try {
    session = spawnOwnedBot(owner);
  } catch (error) {
    tell(owner, `Could not start the unplugged session: ${describeError(error)}`);
    return;
  }

  if (!session) return;
  session.disableDamage = config.disableDamage;
  session.hidePlayers = config.hidePlayers;
  session.expiresAt = Date.now() + timeoutMinutes * 60000;
  applyBotOptions(session.bot, session);

  try {
    stageOwnerInventory(owner, session);
  } catch (error) {
    removeSession(ownerKey(session.ownerName), "inventory staging failed", false);
    tell(owner, `Inventory transfer could not start: ${describeError(error)}`);
    return;
  }

  try {
    commitInventoryToBot(session);
    session.persistent = true;
    saveSessionLedger();
  } catch (error) {
    try {
      restoreStagedInventory(owner, session);
    } catch (rollbackError) {
      console.error(
        `[BedrockUnplugged] Inventory rollback failed for ${owner.name}: ${describeError(rollbackError)}`,
      );
    }
    removeSession(ownerKey(session.ownerName), "inventory commit failed", false);
    tell(owner, `Inventory transfer failed; unplug was cancelled: ${describeError(error)}`);
    return;
  }

  system.runTimeout(() => {
    try {
      owner.runCommand(
        `kick @s Unplugged. Your ghost will AFK for you for up to ${formatDurationMinutes(timeoutMinutes)}.`,
      );
    } catch (error) {
      rollbackFailedDisconnect(owner, session, error);
      return;
    }

    system.runTimeout(() => {
      if (sessionsByOwner.get(ownerKey(session.ownerName)) !== session) return;
      if (isRealOwnerConnected(session)) {
        rollbackFailedDisconnect(owner, session);
        return;
      }
      broadcast(`${session.ownerName} is going unplugged.`);
    }, 20);
  }, 2);
}

function reclaimOnJoin(player) {
  const key = ownerKey(player.name);
  const session = sessionsByOwner.get(key);
  if (!session) return;
  if (session.restoring) {
    system.runTimeout(() => reclaimOnJoin(player), 25);
    return;
  }

  const interruptionMessage =
    session.interruptionReason === "admin"
      ? "Your unplug was removed by an admin."
      : session.restartDisconnected
        ? "A restart interrupted your unplug."
        : undefined;

  if (session.botDied) {
    try {
      if (!session.inventoryCommitted) {
        restoreStagedInventory(player, session);
      }
    } catch (error) {
      tell(
        player,
        `Your staged inventory could not be restored after the bot died: ${describeError(error)}`,
      );
      return;
    }

    const location = session.deathLocation
      ? ` at ${Math.floor(session.deathLocation.x)}, ${Math.floor(session.deathLocation.y)}, ${Math.floor(session.deathLocation.z)} in ${readableDimensionName(session.deathDimension)}`
      : "";
    tell(
      player,
      `Your AFK player ${session.deathReason}${location}. Its inventory dropped there.`,
    );
    try {
      returnPlayerToSpawn(player);
    } catch (error) {
      tell(player, `Could not return you to spawn: ${describeError(error)}`);
    }
    removeSession(key, "owner notified of bot death", false);
    return;
  }

  if (!session.bot) {
    try {
      if (!findEscrow(session)) {
        tell(player, "Your unplug escrow could not be loaded. Session retained.");
        return;
      }
      const escrowSnapshot = captureEscrowSnapshot(session);
      applyInventory(player, escrowSnapshot);
      getEscrowContainer(session.escrow).clearAll();
    } catch (error) {
      tell(
        player,
        `Your unplug escrow could not be restored. Session retained: ${describeError(error)}`,
      );
      console.error(
        `[BedrockUnplugged] Escrow recovery failed for ${player.name}: ${describeError(error)}`,
      );
      return;
    }
  } else {
    try {
      restoreSessionInventoryToOwner(player, session);
    } catch (error) {
      tell(
        player,
        `Your AFK inventory could not be reclaimed. The bot/session was kept for recovery: ${describeError(error)}`,
      );
      console.error(
        `[BedrockUnplugged] Inventory reclaim failed for ${player.name}: ${describeError(error)}`,
      );
      return;
    }
  }

  if (session.botRemoved) {
    try {
      returnPlayerToSpawn(player);
    } catch (error) {
      tell(player, `Could not return you to spawn: ${describeError(error)}`);
    }
  }

  removeSession(key, "owner returned", false);
  if (interruptionMessage) tell(player, interruptionMessage);
}

function listSessions(player) {
  if (sessionsByOwner.size === 0) {
    tell(player, "No unplugged sessions are active.");
    return;
  }

  const now = Date.now();
  const lines = [...sessionsByOwner.values()].map((session) => {
    const minutes = Math.floor((now - session.createdAt) / 60000);
    if (session.botDied) {
      return `${session.ownerName}: died; notice pending, ${minutes}m`;
    }
    if (session.botRemoved) {
      return `${session.ownerName}: removed; recovery pending, ${minutes}m`;
    }
    if (session.restartDisconnected) {
      return `${session.ownerName}: restart recovery pending, ${minutes}m`;
    }
    return `${session.ownerName}: ${session.botName}, ${minutes}m`;
  });
  tell(player, `Active sessions (${lines.length}):\n${lines.join("\n")}`);
}

async function showManageUnplugs(player) {
  const sessions = [...sessionsByOwner.values()];
  const names = sessions.length
    ? sessions.map((session) => {
        const status = session.botDied
          ? "Dead"
          : session.botRemoved
            ? "Removed"
            : "Active";
        return `${session.ownerName} — ${status}`;
      })
    : ["No Unplugs"];
  const response = await new ModalFormData()
    .title("Manage Unplugs")
    .dropdown("Active unplug", names, { defaultValueIndex: 0 })
    .submitButton("Select")
    .show(player);
  if (response.canceled || !sessions.length) return;
  const session = sessions[Number(response.formValues?.[0]) || 0];
  if (!session || sessionsByOwner.get(ownerKey(session.ownerName)) !== session) return;
  const confirmation = await new MessageFormData()
    .title("Remove Unplug")
    .body(session.ownerName)
    .button1("Cancel")
    .button2("Remove")
    .show(player);
  if (confirmation.canceled || confirmation.selection !== 1) return;
  if (session.restoring) {
    try {
      session.bot?.disconnect();
    } catch {}
    session.bot = undefined;
    session.botId = undefined;
    session.restoring = false;
    session.botRemoved = true;
    session.interruptionReason = "admin";
    saveSessionLedger();
  } else if (session.bot) parkSessionForReturn(session, "admin");
  else {
    session.botRemoved = true;
    session.interruptionReason = "admin";
    saveSessionLedger();
  }
  tell(player, `${session.ownerName}'s unplug was removed.`);
}

async function showSettingsMenu(player) {
  const response = await new ModalFormData()
    .title("Settings")
    .toggle("Enable /unplug", { defaultValue: config.unplugCommandEnabled })
    .textField("Default timeout (minutes)", "Whole numbers only", {
      defaultValue: String(config.defaultTimeoutMinutes),
    })
    .textField("Maximum timeout (minutes)", "Whole numbers only", {
      defaultValue: String(config.maxTimeoutMinutes),
    })
    .dropdown("Unplug name color", NAME_COLORS.map(([name]) => name), {
      defaultValueIndex: Math.max(
        0,
        NAME_COLORS.findIndex(([, code]) => code === config.nameColorCode),
      ),
    })
    .toggle("Disable Damage", { defaultValue: config.disableDamage })
    .toggle("Hide Players", { defaultValue: config.hidePlayers })
    .toggle("Unplug AFK players", { defaultValue: config.unplugAfkPlayers })
    .textField("AFK threshold (minutes)", "Whole numbers only", {
      defaultValue: String(config.afkThresholdMinutes),
    })
    .submitButton("Save Settings")
    .show(player);
  if (response.canceled) return;
  const minutesText = String(response.formValues?.[1] ?? "").trim();
  const minutes = Number(minutesText);
  if (!/^\d+$/.test(minutesText) || !Number.isSafeInteger(minutes) || minutes < 1) {
    tell(player, "Default timeout must be a whole number of at least 1 minute.");
    return;
  }
  const maxMinutesText = String(response.formValues?.[2] ?? "").trim();
  const maxMinutes = Number(maxMinutesText);
  if (!/^\d+$/.test(maxMinutesText) || !Number.isSafeInteger(maxMinutes) || maxMinutes < 1) {
    tell(player, "Maximum timeout must be a whole number of at least 1 minute.");
    return;
  }
  if (minutes > maxMinutes) {
    tell(player, "Default timeout cannot exceed the maximum timeout.");
    return;
  }
  const afkThresholdText = String(response.formValues?.[7] ?? "").trim();
  const afkThresholdMinutes = Number(afkThresholdText);
  if (
    !/^\d+$/.test(afkThresholdText) ||
    !Number.isSafeInteger(afkThresholdMinutes) ||
    afkThresholdMinutes < 1
  ) {
    tell(player, "AFK threshold must be a whole number of at least 1 minute.");
    return;
  }
  config.defaultTimeoutMinutes = minutes;
  config.maxTimeoutMinutes = maxMinutes;
  config.unplugCommandEnabled = Boolean(response.formValues?.[0]);
  config.nameColorCode = NAME_COLORS[Number(response.formValues?.[3])]?.[1] ?? "7";
  config.disableDamage = Boolean(response.formValues?.[4]);
  config.hidePlayers = Boolean(response.formValues?.[5]);
  config.unplugAfkPlayers = Boolean(response.formValues?.[6]);
  config.afkThresholdMinutes = afkThresholdMinutes;
  saveConfig();
}

async function showAdminMenu(player) {
  try {
    const response = await new ActionFormData()
      .title("BedrockUnplugged")
      .button("Settings")
      .button("Manage Unplugs")
      .show(player);
    if (response.canceled) return;
    if (response.selection === 0) return await showSettingsMenu(player);
    if (response.selection === 1) return await showManageUnplugs(player);
  } catch (error) {
    tell(player, `Menu failed: ${describeError(error)}`);
  }
}

system.beforeEvents.startup.subscribe((event) => {
  const commands = event.customCommandRegistry;
  const unplugCommand = (name) => ({
    name,
    description: "Leave a simulated player behind and disconnect",
    permissionLevel: CommandPermissionLevel.Any,
    cheatsRequired: false,
    optionalParameters: [
      { type: CustomCommandParamType.Integer, name: "minutes" },
    ],
  });
  const runUnplugCommand = (origin, minutes) => {
    const player = requirePlayer(origin);
    if (!player) return failure("This command must be run by a player.");
    if (!config.unplugCommandEnabled) return failure("The /unplug command is disabled.");
    const duration = minutes ?? config.defaultTimeoutMinutes;
    if (!Number.isInteger(duration) || duration < 1) {
      return failure("Minutes must be at least 1.");
    }
    if (duration > config.maxTimeoutMinutes) {
      return failure(`Minutes cannot exceed ${config.maxTimeoutMinutes}.`);
    }
    system.run(() => beginUnplug(player, duration));
    return success("Creating unplugged session...");
  };

  commands.registerCommand(unplugCommand("afk:unplug"), runUnplugCommand);
  commands.registerCommand(unplugCommand("afk:afk"), runUnplugCommand);

  commands.registerCommand(
    {
      name: "afk:unplugadmin",
      description: "Open BedrockUnplugged settings",
      permissionLevel: CommandPermissionLevel.GameDirectors,
      cheatsRequired: false,
    },
    (origin) => {
      const player = requirePlayer(origin);
      if (!player) return failure("Run this command as an in-world operator.");
      system.run(() => showAdminMenu(player));
      return success();
    },
  );
});

world.afterEvents.playerSpawn.subscribe((event) => {
  if (!event.initialSpawn) return;
  const spawnedPlayer = event.player;
  const spawnedId = spawnedPlayer.id;
  system.run(() => {
    const isManagedBot = [...sessionsByOwner.values()].some(
      (session) => session.botId === spawnedId,
    );
    if (isManagedBot) return;
    reclaimOnJoin(spawnedPlayer);
  });
});

world.afterEvents.entityDie.subscribe((event) => {
  const deadId = event.deadEntity.id;
  const session = [...sessionsByOwner.values()].find(
    (candidate) => candidate.botId === deadId,
  );
  if (!session) return;

  const deadBot = event.deadEntity;

  session.botDied = true;
  session.deathReason = describeDeath(event.damageSource);
  try {
    session.deathLocation = { ...event.deadEntity.location };
    session.deathDimension = event.deadEntity.dimension.id;
  } catch {
    session.deathLocation = undefined;
    session.deathDimension = undefined;
  }
  removeEscrow(session);
  session.bot = undefined;
  saveSessionLedger();
  system.run(() => {
    try {
      deadBot.disconnect();
    } catch (error) {
      console.warn(
        `[BedrockUnplugged] Could not disconnect ${session.ownerName}'s dead bot: ${describeError(error)}`,
      );
    }
  });
  console.warn(
    `[BedrockUnplugged] ${session.ownerName}'s bot ${session.deathReason}.`,
  );
});

system.runInterval(() => {
  const now = Date.now();
  for (const session of sessionsByOwner.values()) {
    if (session.botDied || session.botRemoved || session.restoring || !session.expiresAt || now < session.expiresAt) {
      continue;
    }
    try {
      if (session.bot) parkSessionForReturn(session, "timeout");
      else {
        session.botRemoved = true;
        session.interruptionReason ??= "timeout";
        saveSessionLedger();
      }
    } catch (error) {
      console.error(
        `[BedrockUnplugged] Could not expire ${session.ownerName}'s unplug: ${describeError(error)}`,
      );
    }
  }
}, 20);

system.runInterval(() => {
  for (const session of sessionsByOwner.values()) {
    if (!session.restartDisconnected || session.botDied || session.botRemoved || session.restoring) {
      continue;
    }
    try {
      restoreBotAfterRestart(session);
    } catch (error) {
      console.error(
        `[BedrockUnplugged] Could not restore ${session.ownerName}'s unplug after restart: ${describeError(error)}`,
      );
    }
  }
}, 100);

system.runInterval(() => {
  let changed = false;
  for (const session of sessionsByOwner.values()) {
    if (!session.bot || !session.escrow || session.botDied || session.restoring) continue;
    try {
      writeEscrowSnapshot(session, captureInventory(session.bot));
      session.escrowSyncFailed = false;
      changed = true;
    } catch (error) {
      if (!session.escrowSyncFailed) {
        console.error(
          `[BedrockUnplugged] Escrow sync failed for ${session.ownerName}: ${describeError(error)}`,
        );
        session.escrowSyncFailed = true;
      }
    }
  }
  if (changed) saveSessionLedger();
}, 1);

system.runInterval(() => {
  const realPlayers = world
    .getAllPlayers()
    .filter((player) => !isUnplugBot(player));

  for (const session of sessionsByOwner.values()) {
    const bot = session.bot;
    if (!bot || session.botDied || session.restoring) continue;

    try {
      const botLocation = bot.location;
      const dimensionId = bot.dimension.id;
      let nearest;
      let nearestDistanceSquared = Infinity;

      for (const player of realPlayers) {
        if (player.dimension.id !== dimensionId) continue;
        const location = player.location;
        const dx = location.x - botLocation.x;
        const dy = location.y - botLocation.y;
        const dz = location.z - botLocation.z;
        const distanceSquared = dx * dx + dy * dy + dz * dz;
        if (distanceSquared < nearestDistanceSquared) {
          nearest = player;
          nearestDistanceSquared = distanceSquared;
        }
      }

      if (nearest) bot.lookAtEntity(nearest);
    } catch {
      // A bot or target can become invalid between selection and rotation.
    }
  }
}, LOOK_INTERVAL_TICKS);

system.runInterval(() => {
  if (!config.unplugAfkPlayers) {
    afkTrackingSessions.clear();
    return;
  }

  const now = Date.now();
  const thresholdMs = config.afkThresholdMinutes * 60 * 1000;
  const onlinePlayerIds = new Set();

  for (const player of world.getPlayers()) {
    if (isUnplugBot(player)) continue;
    onlinePlayerIds.add(player.id);

    try {
      let tracking = afkTrackingSessions.get(player.id);
      if (!tracking) {
        tracking = {
          lastCameraActivity: now,
          rotation: player.getRotation(),
        };
        afkTrackingSessions.set(player.id, tracking);
        continue;
      }

      const rotation = player.getRotation();
      if (cameraMoved(tracking.rotation, rotation)) {
        tracking.lastCameraActivity = now;
        tracking.rotation = rotation;
      }

      if (
        now - tracking.lastCameraActivity >= thresholdMs &&
        !sessionsByOwner.has(ownerKey(player.name))
      ) {
        tracking.lastCameraActivity = now;
        beginUnplug(player, config.defaultTimeoutMinutes);
      }
    } catch (error) {
      console.error(
        `[BedrockUnplugged] AFK tracking failed for ${player.name}: ${describeError(error)}`,
      );
    }
  }

  for (const playerId of afkTrackingSessions.keys()) {
    if (!onlinePlayerIds.has(playerId)) afkTrackingSessions.delete(playerId);
  }
}, 20);

system.run(() => {
  loadConfig();
  loadSessionLedger();
});
