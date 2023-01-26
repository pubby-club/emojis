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
const ordering = await fetch(
  "https://raw.githubusercontent.com/googlefonts/emoji-metadata/main/emoji_15_0_ordering.json"
)
  .then((r) => r.json())
  .then((json) => {
    const result = {};

    for (const group of json) {
      for (const emoji of group.emoji) {
        const codepoint = emoji.base
          .map((c) => c.toString(16).toUpperCase().padStart(4, "0"))
          .join(" ");

        if (!result[codepoint]) {
          result[codepoint] = {
            shortcodes: emoji.shortcodes.map((s) =>
              s.substring(1, s.length - 1)
            ),
            emoticons: emoji.emoticons,
            animated: emoji.animated,
          };
        }
      }
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
    shortcodes: ordering[codes]?.shortcodes ?? [],
    emoticons: ordering[codes]?.emoticons ?? [],
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

  if (emoji.shortcodes.length > 0) {
    children.push(
      ...emoji.shortcodes.map((shortcode) =>
        xml_node("shortcode", { text: shortcode })
      )
    );
  }

  if (emoji.emoticons.length > 0) {
    children.push(
      ...emoji.emoticons.map((emoticon) =>
        xml_node("emoticon", { text: emoticon })
      )
    );
  }

  if (emoji.skin_tones.length > 0) {
    children.push(
      xml_node(
        "alternate",
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
      id: emoji.codes.replace(" ", "_"),
      text: emoji.emoji,
      desc: emoji.description,
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
      { id: name.toLocaleLowerCase().replace(/\s+/g, "_").replace("&", "and") },
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
      shortcodes: e.shortcodes.length ? e.shortcodes : undefined,
      emoticons: e.emoticons.length ? e.emoticons : undefined,
      skin_tones: e.skin_tones.length
        ? e.skin_tones.map((e) => ({
            emoji: e.emoji,
            aliases: e.aliases,
          }))
        : undefined,
    }))
  )
);
