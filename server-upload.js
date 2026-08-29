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

app.use(express.json({ limit: '100mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/upload-restore', async (req, res) => {
    try {
        if (!RESTORE_PAGE_PRIVATE_KEY) {
            return res.status(500).json({ success: false, error: 'RESTORE_PAGE_PRIVATE_KEY nav konfigurēts' });
        }
        
        const { fileContent } = req.body;
        if (!fileContent) {
            return res.status(400).json({ success: false, error: 'Nav faila satura' });
        }
        
        const turbo = TurboFactory.authenticated({
            signer: new EthereumSigner(RESTORE_PAGE_PRIVATE_KEY),
            token: TURBO_TOKEN,
            gatewayUrl: 'https://sepolia.base.org',
            uploadServiceConfig: { url: TURBO_UPLOAD_URL },
            paymentServiceConfig: { url: TURBO_PAYMENT_URL }
        });
        
        const fileBuffer = Buffer.from(fileContent, 'base64');
        
        const result = await turbo.uploadFile({
            fileStreamFactory: () => Readable.from(fileBuffer),
            fileSizeFactory: () => fileBuffer.length,
            dataItemOpts: {
                tags: [
                    { name: 'App-Name', value: 'PermRepo' },
                    { name: 'Type', value: 'restore-page' },
                    { name: 'Content-Type', value: 'text/html' },
                    { name: 'Title', value: 'PermRepo Restore' }
                ]
            }
        });
        
        res.json({ success: true, txId: result.id });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message || String(error) });
    }
});

app.listen(PORT, () => {
    console.log(`Upload serveris uz porta ${PORT}`);
});
