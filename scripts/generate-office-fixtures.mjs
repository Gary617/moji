import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const manifestPath = resolve(root, "tests/fixtures/office/manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const fixtureRoot = resolve(root, "tests/fixtures/office/generated");
const png1x1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let value = n;
  for (let i = 0; i < 8; i += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, value] of entries) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const checksum = crc32(data);
    const header = Buffer.alloc(30 + nameBuffer.length);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(0, 6);
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(0, 12);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuffer.length, 26);
    nameBuffer.copy(header, 30);
    local.push(header, data);

    const directory = Buffer.alloc(46 + nameBuffer.length);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt16LE(0, 12);
    directory.writeUInt16LE(0, 14);
    directory.writeUInt32LE(checksum, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(nameBuffer.length, 28);
    directory.writeUInt16LE(0, 30);
    directory.writeUInt16LE(0, 32);
    directory.writeUInt16LE(0, 34);
    directory.writeUInt16LE(0, 36);
    directory.writeUInt32LE(0, 38);
    directory.writeUInt32LE(offset, 42);
    nameBuffer.copy(directory, 46);
    central.push(directory);
    offset += header.length + data.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuffer, end]);
}

function xmlEscape(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function contentTypes(format, features) {
  const defaults = '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>';
  if (format === "docx") {
    return `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${features.includes("批注") ? '<Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>' : ""}</Types>`;
  }
  if (format === "pptx") {
    return `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>${features.includes("图表") ? '<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>' : ""}</Types>`;
  }
  return `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>${features.includes("批注") ? '<Override PartName="/xl/comments1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml"/>' : ""}</Types>`;
}

function officeEntries(sample) {
  const marker = `POC-${sample.id}`;
  const features = sample.features;
  const entries = [["[Content_Types].xml", contentTypes(sample.format, features)], ["_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="/' + (sample.format === "docx" ? "word/document.xml" : sample.format === "pptx" ? "ppt/presentation.xml" : "xl/workbook.xml") + '"/></Relationships>']];
  if (sample.format === "docx") {
    const table = features.includes("表格") ? "<w:tbl><w:tr><w:tc><w:p><w:r><w:t>CELL_A1</w:t></w:r></w:p></w:tc></w:tr></w:tbl>" : "";
    const drawing = features.includes("图片") ? "<w:drawing><wp:inline><a:graphic><a:graphicData><pic:pic/></a:graphicData></a:graphic></wp:inline></w:drawing>" : "";
    const comments = features.includes("批注") ? "<w:commentRangeStart w:id=\"0\"/><w:r><w:t>commented</w:t></w:r><w:commentRangeEnd w:id=\"0\"/>" : "";
    entries.push(["word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body><w:p><w:r><w:t>${xmlEscape(marker)} 中文字体复杂排版</w:t></w:r></w:p>${comments}<w:p><w:r><w:t>${xmlEscape(features.join(" "))}</w:t></w:r></w:p>${table}${drawing}<w:sectPr/></w:body></w:document>`]);
    entries.push(["word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${features.includes("批注") ? '<Relationship Id="rIdComment" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments" Target="comments.xml"/>' : ""}${features.includes("图片") ? '<Relationship Id="rIdImage" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.png"/>' : ""}</Relationships>`]);
    if (features.includes("批注")) entries.push(["word/comments.xml", '<?xml version="1.0" encoding="UTF-8"?><w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:comment w:id="0" w:author="POC"><w:p><w:r><w:t>批注</w:t></w:r></w:p></w:comment></w:comments>']);
    if (features.includes("图片")) entries.push(["word/media/image1.png", png1x1]);
  } else if (sample.format === "pptx") {
    entries.push(["ppt/presentation.xml", '<?xml version="1.0" encoding="UTF-8"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>']);
    entries.push(["ppt/_rels/presentation.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>']);
    entries.push(["ppt/slides/slide1.xml", `<?xml version="1.0" encoding="UTF-8"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>${xmlEscape(marker)} 中文字体复杂排版 ${xmlEscape(features.join(" "))}</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`]);
    if (features.includes("图片")) entries.push(["ppt/media/image1.png", png1x1]);
    if (features.includes("图表")) entries.push(["ppt/charts/chart1.xml", '<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:title><c:tx><c:rich><a:p xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:r><a:t>POC Chart</a:t></a:r></a:p></c:rich></c:tx></c:title></c:chart></c:chartSpace>']);
  } else {
    const formula = features.includes("公式") ? "<f>SUM(A1:A2)</f><v>3</v>" : "<v>2</v>";
    entries.push(["xl/workbook.xml", '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>']);
    entries.push(["xl/_rels/workbook.xml.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>']);
    entries.push(["xl/worksheets/sheet1.xml", `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${xmlEscape(marker)}</t></is></c><c r="B2" t="n">${formula}</c></row></sheetData></worksheet>`]);
    if (features.includes("图片")) entries.push(["xl/media/image1.png", png1x1]);
    if (features.includes("图表")) entries.push(["xl/charts/chart1.xml", '<?xml version="1.0" encoding="UTF-8"?><c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:autoTitleDeleted val="0"/></c:chart></c:chartSpace>']);
    if (features.includes("批注")) entries.push(["xl/comments1.xml", '<?xml version="1.0" encoding="UTF-8"?><comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author>POC</author></authors><commentList><comment ref="A1" authorId="0"><text><t>批注</t></text></comment></commentList></comments>']);
  }
  return entries;
}

await mkdir(fixtureRoot, { recursive: true });
for (const sample of manifest.samples) {
  const target = resolve(root, "tests/fixtures/office", "generated", `${sample.id}.${sample.format}`);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, zip(officeEntries(sample)));
}
console.log(`Generated ${manifest.samples.length} deterministic OOXML fixtures in ${fixtureRoot}`);
