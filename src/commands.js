import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";

const reasons = [
  ["Corrupt / won't play", "corrupt"],
  ["Bad audio", "audio"],
  ["Bad video", "video"],
  ["Wrong language", "language"],
  ["Wrong movie / episode", "wrong-content"],
  ["Bad subtitles", "subtitles"],
  ["Other", "other"],
];

export const repairCommand = new SlashCommandBuilder()
  .setName("repair")
  .setDescription("Repair a bad movie or TV episode")
  .addSubcommand((sub) =>
    sub
      .setName("movie")
      .setDescription("Report and repair a movie file")
      .addStringOption((opt) => opt.setName("title").setDescription("Movie title").setRequired(true).setAutocomplete(true))
      .addStringOption((opt) => {
        opt.setName("reason").setDescription("What's wrong?").setRequired(true);
        for (const [name, value] of reasons) opt.addChoices({ name, value });
        return opt;
      })
      .addStringOption((opt) => opt.setName("note").setDescription("Optional details").setMaxLength(500)),
  )
  .addSubcommand((sub) =>
    sub
      .setName("episode")
      .setDescription("Report and repair a TV episode file")
      .addStringOption((opt) => opt.setName("title").setDescription("Series title").setRequired(true).setAutocomplete(true))
      .addIntegerOption((opt) => opt.setName("season").setDescription("Season number").setRequired(true).setMinValue(0))
      .addIntegerOption((opt) => opt.setName("episode").setDescription("Episode number").setRequired(true).setMinValue(1))
      .addStringOption((opt) => {
        opt.setName("reason").setDescription("What's wrong?").setRequired(true);
        for (const [name, value] of reasons) opt.addChoices({ name, value });
        return opt;
      })
      .addStringOption((opt) => opt.setName("note").setDescription("Optional details").setMaxLength(500)),
  );

export const mediamedicCommand = new SlashCommandBuilder()
  .setName("mediamedic")
  .setDescription("MediaMedic administration")
  .addSubcommand((sub) => sub.setName("health").setDescription("Check Radarr, Sonarr, and safety mode"))
  .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages);

export const commands = [repairCommand.toJSON(), mediamedicCommand.toJSON()];
