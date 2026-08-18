import { ZetaHelperThread } from './vendor/zetajs/zetaHelper.js';

const helper = new ZetaHelperThread();
const css = helper.css;
const zetajs = helper.zetajs;

function property(name, value) {
  return new css.beans.PropertyValue({ Name: name, Value: value });
}

function filterName(format) {
  if (format === 'docx') return 'Office Open XML Text';
  if (format === 'pptx') return 'Impress MS PowerPoint 2007 XML';
  return 'Calc MS Excel 2007 XML';
}

function readText(model) {
  return String(model.getText().getString());
}

function readPresentationText(model) {
  const pages = model.getDrawPages();
  const pageCount = Number(pages.getCount());
  let text = '';
  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const page = pages.getByIndex(pageIndex);
    const shapeCount = Number(page.getCount());
    for (let shapeIndex = 0; shapeIndex < shapeCount; shapeIndex += 1) {
      const shape = page.getByIndex(shapeIndex);
      try {
        text += String(shape.getString());
      } catch {
        // Images and charts do not expose XText; continue with other shapes.
      }
      if (text.length > 0) return text;
    }
  }
  return text;
}

function spreadsheetCell(model, sheetName, cellName) {
  const sheets = model.getSheets();
  const sheet = sheets.getByName(sheetName);
  return sheet.getCellRangeByName(cellName);
}

function readContent(model, format, edit) {
  if (format === 'docx') return readText(model);
  if (format === 'pptx') return readPresentationText(model);
  return String(spreadsheetCell(model, edit.sheet, edit.cell).getString());
}

function applyEdit(model, format, edit) {
  if (format === 'docx') {
    const text = model.getText();
    const before = String(text.getString());
    if (edit.kind === 'replace-text') {
      text.setString(before.replaceAll(edit.find, edit.replace));
    } else {
      text.setString(`${before}\n${edit.text}`);
    }
    return;
  }
  if (format === 'pptx') {
    const pages = model.getDrawPages();
    const page = pages.getByIndex(0);
    const shapeCount = Number(page.getCount());
    for (let shapeIndex = 0; shapeIndex < shapeCount; shapeIndex += 1) {
      const shape = page.getByIndex(shapeIndex);
      try {
        const before = String(shape.getString());
        shape.setString(`${before}\n${edit.text ?? 'ZETA_POC_EDITED'}`);
        return;
      } catch {
        // Try the next shape if this one is not text-capable.
      }
    }
    throw new Error('PPTX has no editable text shape');
  }
  const cell = spreadsheetCell(model, edit.sheet, edit.cell);
  cell.setString(String(edit.value));
}

let currentModel;

helper.thrPort.onmessage = async (event) => {
  if (event.data.cmd !== 'roundtrip') throw new Error(`Unknown POC command: ${event.data.cmd}`);
  try {
    const desktop = helper.desktop;
    const format = event.data.format;
    const edit = event.data.edit;
    currentModel = desktop.loadComponentFromURL(`file://${event.data.source}`, '_default', 0, [property('Hidden', true)]);
    const sourceText = readContent(currentModel, format, edit);
    applyEdit(currentModel, format, edit);
    currentModel.storeAsURL(`file://${event.data.target}`, [
      property('Overwrite', true),
      property('FilterName', filterName(format)),
    ]);
    currentModel.close(true);
    currentModel = desktop.loadComponentFromURL(`file://${event.data.target}`, '_default', 0, [property('Hidden', true)]);
    const reopenedText = readContent(currentModel, format, edit);
    const marker = edit.marker ?? edit.replace ?? edit.text ?? edit.value;
    const markerPresent = reopenedText.includes(String(marker));
    currentModel.close(true);
    currentModel = undefined;
    zetajs.mainPort.postMessage({
      cmd: 'roundtrip',
      id: event.data.id,
      format,
      reopened: true,
      markerPresent,
      sourceText,
      reopenedText,
      sourceTextLength: sourceText.length,
      reopenedTextLength: reopenedText.length,
    });
  } catch (error) {
    try { currentModel?.close(true); } catch {}
    currentModel = undefined;
    const caught = zetajs.catchUnoException(error);
    zetajs.mainPort.postMessage({ cmd: 'error', message: String(caught?.Message || error?.message || error) });
  }
};

zetajs.mainPort.postMessage({ cmd: 'ready' });
