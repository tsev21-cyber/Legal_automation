const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');
const mammoth = require('mammoth');

class DriveClient {
  constructor({ serviceAccountPath, folderId } = {}) {
    this.folderId = folderId || process.env.GOOGLE_DRIVE_FOLDER_ID;
    const keyFile = serviceAccountPath || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

    if (!keyFile || !fs.existsSync(keyFile)) {
      this.drive = null;
      return;
    }

    const auth = new google.auth.GoogleAuth({
      keyFile,
      scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    });

    this.drive = google.drive({ version: 'v3', auth });
  }

  // List .docx files in a folder (and optionally subfolder matching a name)
  async listPetitions(subfolderName = null) {
    let targetFolderId = this.folderId;

    if (subfolderName) {
      const res = await this.drive.files.list({
        q: `'${this.folderId}' in parents and name contains '${subfolderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
        fields: 'files(id, name)',
      });
      if (res.data.files.length > 0) {
        targetFolderId = res.data.files[0].id;
      }
    }

    const res = await this.drive.files.list({
      q: `'${targetFolderId}' in parents and (name contains '.docx' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') and trashed = false`,
      fields: 'files(id, name, modifiedTime, size)',
      orderBy: 'modifiedTime desc',
      pageSize: 20,
    });

    return res.data.files || [];
  }

  // Download a file and extract its text content
  async getFileText(fileId) {
    const dest = path.join(require('os').tmpdir(), `drive_${fileId}.docx`);

    const res = await this.drive.files.get(
      { fileId, alt: 'media' },
      { responseType: 'stream' }
    );

    await new Promise((resolve, reject) => {
      const writer = fs.createWriteStream(dest);
      res.data.pipe(writer);
      writer.on('finish', resolve);
      writer.on('error', reject);
    });

    const { value: text } = await mammoth.extractRawText({ path: dest });
    fs.unlinkSync(dest);
    return text.trim();
  }

  // Get 2-3 petition examples matching a task type for style reference
  async getStyleExamples(taskType, maxExamples = 3) {
    if (!this.drive) return [];
    const folderKeyword = this._getFolderKeyword(taskType);
    const files = await this.listPetitions(folderKeyword);

    const examples = [];
    for (const file of files.slice(0, maxExamples)) {
      try {
        const text = await this.getFileText(file.id);
        if (text.length > 200) {
          examples.push({ name: file.name, text: text.slice(0, 3000) }); // first 3000 chars
        }
      } catch (e) {
        console.warn(`Could not read Drive file ${file.name}: ${e.message}`);
      }
    }

    return examples;
  }

  _getFolderKeyword(taskType) {
    const lower = (taskType || '').toLowerCase();
    if (lower.includes('recurso')) return 'Recurso';
    if (lower.includes('contrarraz')) return 'Contrarrazões';
    if (lower.includes('embarg')) return 'Embargos';
    if (lower.includes('idpj')) return 'IDPJ';
    if (lower.includes('informa')) return 'Informações';
    return null; // fall back to root folder
  }
}

module.exports = DriveClient;
