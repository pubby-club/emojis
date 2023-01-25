import { writeFile } from "fs/promises";
import readline from "readline/promises";
import { Readable } from "stream";

function encode(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const data = await fetch(
  "https://unicode.org/Public/emoji/15.0/emoji-test.txt"
);
const shortcodes = await fetch(
  "https://raw.githubusercontent.com/milesj/emojibase/master/packages/data/en/shortcodes/emojibase.raw.json"
)
  .then((r) => r.json())
  .then((json) => {
    const result = {};

    for (const [codepoint, codes] of Object.entries(json)) {
      result[codepoint] ??= [];
      result[codepoint].push(...[].concat(codes));
    }

    return result;
  });

const lines = readline.createInterface({
  input: Readable.from(await data.text()),
});

let groups = [];
const emojis = [];
let lastEmoji = null;

for await (const line of lines) {
  if (line.startsWith("# group:")) {
    const group = line.substring(9).trim();
    if (group !== "Component") {
      groups.push(group);
    }
    continue;
  }

  if (!line.length || line.startsWith("#")) {
    continue;
  }

  const [_, codes, status, emoji, version, description] = line.match(
    /^(.+?)\s+;\s+(.+?)\s+#\s+(.+?)\s*E(.+?)\s(.+)$/
  );

  if (status !== "fully-qualified") {
    continue;
  }

  const currentEmoji = {
    emoji,
    codes,
    group: groups.length - 1,
    description,
    version,
    skin_tones: [],
    aliases: shortcodes[codes] ?? [],
  };

  if (description.includes("skin tone")) {
    lastEmoji.skin_tones.push(currentEmoji);
  } else {
    lastEmoji = currentEmoji;
    emojis.push(currentEmoji);
  }
}

function xml_node(name, attrs = {}, children = []) {
  return {
    name,
    attrs,
    children,
  };
}

function emojiNode(emoji) {
  const children = [];

  if (emoji.aliases.length > 0) {
    children.push(
      ...emoji.aliases.map((alias) => xml_node("alias", { text: alias }))
    );
  }

  if (emoji.skin_tones.length > 0) {
    children.push(
      xml_node(
        "variant",
        {
          type: "skin-tone",
        },
        emoji.skin_tones.map((e) => emojiNode(e))
      )
    );
  }

  return xml_node(
    "emoji",
    {
      text: emoji.emoji,
      codes: emoji.codes,
      description: emoji.description,
      version: emoji.version,
    },
    children
  );
}

const xmlDocument = xml_node(
  "emoji-data",
  {
    "unicode-version": "15.0",
  },
  groups.map((name, i) =>
    xml_node(
      "group",
      { name },
      emojis
        .filter((emoji) => emoji.group === i)
        .map((emoji) => emojiNode(emoji))
    )
  )
);

function renderXML(document, { pretty = true } = {}) {
  let xml = "";
  let depth = 0;

  function br() {
    if (pretty) {
      write(`\n${"  ".repeat(depth)}`);
    }
  }

  function write(data) {
    xml += data;
  }

  function indent(cb, size = 1) {
    depth += size;
    cb();
    depth -= size;
  }

  function renderNode(node) {
    write(`<${node.name}`);

    const attrs = Object.entries(node.attrs);

    if (!pretty || attrs.length < 4) {
      for (const [attr, value] of attrs) {
        write(` ${attr}="${encode(value)}"`);
      }
    } else {
      indent(() => {
        for (const [attr, value] of attrs) {
          br();
          write(`${attr}="${encode(value)}"`);
        }
      });
      br();
    }

    if (node.children.length <= 0) {
      return write("/>");
    } else {
      write(">");
    }

    indent(() => {
      for (const child of node.children) {
        br();
        renderNode(child);
      }
    });
    br();
    write(`</${node.name}>`);
  }

  write(`<?xml version="1.0" encoding="UTF-8" standalone="no" ?>\n`);
  renderNode(document);

  return xml;
}

await writeFile(`./data/emojis.xml`, renderXML(xmlDocument, { pretty: false }));
await writeFile(
  `./data/emojis.json`,
  JSON.stringify(
    emojis.map((e) => ({
      emoji: e.emoji,
      category: groups[e.group],
      aliases: e.aliases.length ? e.aliases : undefined,
      skin_tones: e.skin_tones.length
        ? e.skin_tones.map((e) => ({
            emoji: e.emoji,
            aliases: e.aliases,
          }))
        : undefined,
    }))
  )
);
