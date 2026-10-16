// server-upload.js
// PermRepo Restore Platform — upload server
// Augšupielādē visus failus uz Arweave un automātiski izveido manifestu.

import express from 'express';
import { TurboFactory, EthereumSigner } from '@ardrive/turbo-sdk';
import { Readable } from 'stream';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3001;

const RESTORE_PAGE_PRIVATE_KEY = process.env.RESTORE_PAGE_PRIVATE_KEY;
const TURBO_TOKEN = process.env.TURBO_TOKEN || 'base-eth';
const TURBO_UPLOAD_URL = process.env.TURBO_UPLOAD_URL || 'https://upload.services.ar-io.dev';
const TURBO_PAYMENT_URL = process.env.TURBO_PAYMENT_URL || 'https://payment.services.ar-io.dev';
const GATEWAY_URL = process.env.GATEWAY_URL || 'https://sepolia.base.org';

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB uz failu
const MAX_BUNDLE_BYTES = 50 * 1024 * 1024; // 50 MB kopā
const MAX_FILES = 50;

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ================================================== */
/* Palīgfunkcijas                                      */
/* ================================================== */

function getContentType(fileName) {
    const name = String(fileName || '').toLowerCase();
    if (name.endsWith('.html')) return 'text/html; charset=utf-8';
    if (name.endsWith('.css')) return 'text/css; charset=utf-8';
    if (name.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (name.endsWith('.json')) return 'application/json; charset=utf-8';
    if (name.endsWith('.svg')) return 'image/svg+xml';
    if (name.endsWith('.png')) return 'image/png';
    if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
    if (name.endsWith('.woff2')) return 'font/woff2';
    if (name.endsWith('.woff')) return 'font/woff';
    if (name.endsWith('.ttf')) return 'font/ttf';
    return 'application/octet-stream';
}

function getFileType(fileName) {
    const name = String(fileName || '').toLowerCase();
    if (name.endsWith('.html')) return 'restore-page';
    if (name.endsWith('.css')) return 'style';
    if (name.endsWith('.js')) return 'script';
    if (name.endsWith('.svg')) return 'icon';
    if (name.endsWith('.json')) return 'path-manifest';
    return 'asset';
}

function validateFileName(name) {
    if (typeof name !== 'string' || name.length === 0 || name.length > 200) return false;
    // Atļauj tikai drošus failu nosaukumus (bez ../ vai / sākumā)
    if (name.startsWith('/') || name.includes('..') || name.includes('\\')) return false;
    return /^[a-zA-Z0-9._\-/]+$/.test(name);
}

function createTurboClient() {
    return TurboFactory.authenticated({
        signer: new EthereumSigner(RESTORE_PAGE_PRIVATE_KEY),
        token: TURBO_TOKEN,
        gatewayUrl: GATEWAY_URL,
        uploadServiceConfig: { url: TURBO_UPLOAD_URL },
        paymentServiceConfig: { url: TURBO_PAYMENT_URL }
    });
}

async function uploadSingleFile(turbo, fileName, fileBuffer, bundleTag) {
    const contentType = getContentType(fileName);
    const fileType = getFileType(fileName);

    const result = await turbo.uploadFile({
        fileStreamFactory: () => Readable.from(fileBuffer),
        fileSizeFactory: () => fileBuffer.length,
        dataItemOpts: {
            tags: [
                { name: 'App-Name', value: 'PermRepo' },
                { name: 'App-Version', value: 'Restore-1.0' },
                { name: 'Type', value: fileType },
                { name: 'File-Name', value: fileName },
                { name: 'Content-Type', value: contentType },
                { name: 'Bundle', value: bundleTag }
            ]
        }
    });

    return result.id;
}

/* ================================================== */
/* Batch augšupielāde ar automātisku manifestu         */
/* ================================================== */

app.post('/api/upload-bundle', async (req, res) => {
    try {
        if (!RESTORE_PAGE_PRIVATE_KEY) {
            return res.status(500).json({
                success: false,
                error: 'RESTORE_PAGE_PRIVATE_KEY nav konfigurēts'
            });
        }

        const { files } = req.body;

        if (!Array.isArray(files) || files.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'Nav failu (files masīvs ir tukšs)'
            });
        }

        if (files.length > MAX_FILES) {
            return res.status(400).json({
                success: false,
                error: `Pārāk daudz failu (maksimums ${MAX_FILES})`
            });
        }

        // Validē visus failus pirms augšupielādes
        const validated = [];
        let totalBytes = 0;

        for (const file of files) {
            if (!file || typeof file !== 'object') {
                return res.status(400).json({
                    success: false,
                    error: 'Nederīgs faila ieraksts'
                });
            }

            const { name, content } = file;

            if (!validateFileName(name)) {
                return res.status(400).json({
                    success: false,
                    error: `Nederīgs faila nosaukums: ${name}`
                });
            }

            if (typeof content !== 'string' || content.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: `Failam ${name} nav satura`
                });
            }

            let buffer;
            try {
                buffer = Buffer.from(content, 'base64');
            } catch {
                return res.status(400).json({
                    success: false,
                    error: `Neizdevās dekodēt base64 failam ${name}`
                });
            }

            if (buffer.length === 0) {
                return res.status(400).json({
                    success: false,
                    error: `Fails ${name} ir tukšs`
                });
            }

            if (buffer.length > MAX_FILE_BYTES) {
                return res.status(400).json({
                    success: false,
                    error: `Fails ${name} pārsniedz ${MAX_FILE_BYTES} baitu limitu`
                });
            }

            totalBytes += buffer.length;
            if (totalBytes > MAX_BUNDLE_BYTES) {
                return res.status(400).json({
                    success: false,
                    error: `Kopējais apjoms pārsniedz ${MAX_BUNDLE_BYTES} baitu limitu`
                });
            }

            validated.push({ name, buffer });
        }

        // Pārbauda, ka ir restore.html (vai cits .html fails)
        const hasHtml = validated.some(f => f.name.toLowerCase().endsWith('.html'));
        if (!hasHtml) {
            return res.status(400).json({
                success: false,
                error: 'Trūkst .html faila (piemēram, restore.html)'
            });
        }

        const turbo = createTurboClient();
        const bundleTag = `bundle-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

        console.log(`\n📦 Sāk augšupielādēt ${validated.length} failus (${totalBytes} bytes)`);
        console.log(`   Bundle tag: ${bundleTag}`);

        // Augšupielādē katru failu
        const uploadedFiles = {};
        for (const { name, buffer } of validated) {
            try {
                console.log(`   ⬆️  Augšupielādē: ${name} (${buffer.length} bytes)`);
                const txId = await uploadSingleFile(turbo, name, buffer, bundleTag);
                uploadedFiles[name] = txId;
                console.log(`   ✅ ${name} → ${txId}`);
            } catch (error) {
                console.error(`   ❌ Kļūda augšupielādējot ${name}:`, error.message);
                return res.status(500).json({
                    success: false,
                    error: `Neizdevās augšupielādēt ${name}: ${error.message || String(error)}`,
                    partial: uploadedFiles
                });
            }
        }

        // Izveido manifestu
        const manifestPaths = {};
        for (const [name, txId] of Object.entries(uploadedFiles)) {
            manifestPaths[name] = { id: txId };
        }

        // Atrod index failu (prioritāte: restore.html, tad index.html, tad pirmais .html)
        let indexPath = null;
        if (uploadedFiles['restore.html']) {
            indexPath = 'restore.html';
        } else if (uploadedFiles['index.html']) {
            indexPath = 'index.html';
        } else {
            indexPath = validated.find(f => f.name.toLowerCase().endsWith('.html'))?.name;
        }

        const manifest = {
            manifest: 'arweave/paths',
            version: '0.2.0',
            index: { path: indexPath },
            paths: manifestPaths
        };

        console.log(`\n📋 Izveido manifestu ar ${Object.keys(manifestPaths).length} failiem`);
        console.log(`   Index: ${indexPath}`);

        const manifestBuffer = Buffer.from(JSON.stringify(manifest), 'utf8');

        // Augšupielādē manifestu
        const manifestResult = await turbo.uploadFile({
            fileStreamFactory: () => Readable.from(manifestBuffer),
            fileSizeFactory: () => manifestBuffer.length,
            dataItemOpts: {
                tags: [
                    { name: 'App-Name', value: 'PermRepo' },
                    { name: 'App-Version', value: 'Restore-1.0' },
                    { name: 'Type', value: 'path-manifest' },
                    { name: 'Content-Type', value: 'application/x.arweave-manifest+json' },
                    { name: 'Bundle', value: bundleTag }
                ]
            }
        });

        console.log(`✅ Manifests → ${manifestResult.id}\n`);

        return res.json({
            success: true,
            manifestTxId: manifestResult.id,
            index: indexPath,
            files: uploadedFiles,
            bundleTag,
            fileCount: Object.keys(uploadedFiles).length,
            totalBytes
        });

    } catch (error) {
        console.error('Bundle upload error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || String(error)
        });
    }
});

/* ================================================== */
/* Atpakaļsaderība — viens fails                        */
/* ================================================== */

app.post('/api/upload-restore', async (req, res) => {
    try {
        if (!RESTORE_PAGE_PRIVATE_KEY) {
            return res.status(500).json({
                success: false,
                error: 'RESTORE_PAGE_PRIVATE_KEY nav konfigurēts'
            });
        }

        const { fileName, fileContent } = req.body;
        if (!fileContent) {
            return res.status(400).json({
                success: false,
                error: 'Nav faila satura'
            });
        }

        if (!validateFileName(fileName)) {
            return res.status(400).json({
                success: false,
                error: 'Nederīgs faila nosaukums'
            });
        }

        const turbo = createTurboClient();
        const fileBuffer = Buffer.from(fileContent, 'base64');
        const txId = await uploadSingleFile(turbo, fileName, fileBuffer, 'single');

        res.json({ success: true, txId });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message || String(error)
        });
    }
});

/* ================================================== */
/* Veselības pārbaude                                  */
/* ================================================== */

app.get('/api/health', (req, res) => {
    res.json({
        success: true,
        hasKey: Boolean(RESTORE_PAGE_PRIVATE_KEY),
        turboUploadUrl: TURBO_UPLOAD_URL,
        turboPaymentUrl: TURBO_PAYMENT_URL,
        maxFileBytes: MAX_FILE_BYTES,
        maxBundleBytes: MAX_BUNDLE_BYTES,
        maxFiles: MAX_FILES
    });
});

/* ================================================== */
/* Start serveris                                      */
/* ================================================== */

app.listen(PORT, () => {
    console.log(`\n🚀 PermRepo Upload Server started`);
    console.log(`   Port: ${PORT}`);
    console.log(`   Turbo Upload: ${TURBO_UPLOAD_URL}`);
    console.log(`   Turbo Payment: ${TURBO_PAYMENT_URL}`);
    console.log(`   Gateway: ${GATEWAY_URL}`);
    console.log(`   RESTORE_PAGE_PRIVATE_KEY: ${RESTORE_PAGE_PRIVATE_KEY ? '✅' : '❌ NAV'}`);
    console.log(`   Max file: ${MAX_FILE_BYTES} bytes`);
    console.log(`   Max bundle: ${MAX_BUNDLE_BYTES} bytes`);
    console.log(`   Max files: ${MAX_FILES}\n`);
});
