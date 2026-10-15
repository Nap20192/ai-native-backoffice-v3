import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string) => readFileSync(resolve(root, file), "utf8");
const bytes = (file: string) => readFileSync(resolve(root, file));

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngSize = (file: string) => {
  const data = bytes(file);
  expect([...data.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
};

/** Пиксели PNG 8 бит RGBA без чересстрочности. Так пишет rsvg-convert. */
function pngPixels(file: string): { width: number; height: number; data: Buffer } {
  const png = bytes(file);
  const { width, height } = pngSize(file);
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length; ) {
    const length = png.readUInt32BE(at);
    const type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT") idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const cur = raw[y * (stride + 1) + 1 + x];
      const left = x >= 4 ? data[y * stride + x - 4] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= 4 ? data[(y - 1) * stride + x - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      }
      data[y * stride + x] = (cur + predictor) & 0xff;
    }
  }
  return { width, height, data };
}

const hexAt = (image: ReturnType<typeof pngPixels>, x: number, y: number) => {
  const i = (y * image.width + x) * 4;
  return [0, 1, 2].map((c) => image.data[i + c].toString(16).padStart(2, "0")).join("");
};

describe("index.html", () => {
  const html = read("index.html");

  it("names the console in Russian and carries no OpenMA address", () => {
    expect(html).toContain("<title>Консоль агентов</title>");
    expect(html).not.toMatch(/openma/i);
    expect(html).not.toContain('rel="canonical"');
    for (const tag of ['property="og:url"', 'property="og:image', 'name="twitter:image"']) {
      expect(html).not.toContain(tag);
    }
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it("keeps the site name and the social card text", () => {
    expect(html).toContain('<meta property="og:site_name" content="Консоль агентов" />');
    expect(html).toContain('<meta name="twitter:card" content="summary" />');
  });

  it("points the icons at files that exist", () => {
    for (const href of ["/logo.svg", "/apple-touch-icon.svg"]) {
      expect(html).toContain(`href="${href}"`);
      expect(existsSync(resolve(root, "public", href.slice(1)))).toBe(true);
    }
    expect(html).toContain('rel="mask-icon" href="/logo.svg" color="#00805e"');
  });
});

describe("public icons", () => {
  const svgs = ["logo.svg", "apple-touch-icon.svg", "og.svg"];

  it("keep their file names", () => {
    for (const name of [...svgs, "logo.png", "favicon.png"]) {
      expect(existsSync(resolve(root, "public", name)), name).toBe(true);
    }
  });

  it("carry no OpenMA text and no OpenMA mark", () => {
    for (const name of svgs) {
      const svg = read(`public/${name}`);
      expect(svg, name).not.toMatch(/openma|open managed/i);
      expect(svg, name).not.toContain("M279 363H346");
      expect(svg, name).not.toContain("#f84f32");
    }
  });

  it("use the DDC green", () => {
    for (const name of svgs) {
      expect(read(`public/${name}`).toLowerCase(), name).toContain("#00805e");
    }
  });

  it("are valid SVG with a viewBox", () => {
    for (const name of svgs) {
      const svg = read(`public/${name}`);
      expect(svg, name).toMatch(/<svg[^>]+xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      expect(svg, name).toMatch(/viewBox="/);
    }
  });

  it("keep the PNG sizes the browser expects", () => {
    expect(pngSize("public/favicon.png")).toEqual({ width: 32, height: 32 });
    const logo = pngSize("public/logo.png");
    expect(logo.width).toBe(logo.height);
    expect(logo.width).toBeGreaterThanOrEqual(128);
  });

  it("paint the DDC green with a white letter and no coral", () => {
    for (const file of ["public/favicon.png", "public/logo.png"]) {
      const image = pngPixels(file);
      const seen = new Set<string>();
      for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
          if (image.data[(y * image.width + x) * 4 + 3] > 200) seen.add(hexAt(image, x, y));
        }
      }
      // Над буквой поле зелёное, а в знаке есть белые штрихи буквы «А».
      expect(hexAt(image, Math.floor(image.width / 2), Math.floor(image.height * 0.12)), file).toBe("00805e");
      expect(seen.has("ffffff"), file).toBe(true);
      expect(seen.has("f84f32"), file).toBe(false);
    }
  });
});
