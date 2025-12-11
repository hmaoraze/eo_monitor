// 文件路径: ./node-functions/upload.js
// 访问路径: example.com/upload

import { 
  S3Client, 
  CreateMultipartUploadCommand, 
  UploadPartCommand, 
  CompleteMultipartUploadCommand 
} from '@aws-sdk/client-s3';

export async function onRequestGet() {
  return new Response(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>文件分片上传</title>
  <style>
    body { font-family: sans-serif; padding: 20px; }
    .progress-bar { width: 100%; background-color: #f0f0f0; border-radius: 4px; overflow: hidden; margin-top: 10px; }
    .progress-fill { height: 20px; background-color: #4caf50; width: 0%; transition: width 0.3s; }
  </style>
</head>
<body>
  <h3>文件上传 (分片大小: 512KB)</h3>
  <input type="file" id="f">
  <div class="progress-bar"><div id="p" class="progress-fill"></div></div>
  <div id="s" style="margin-top: 10px;"></div>
  <script>
    const CHUNK_SIZE = 512 * 1024; // 512KB

    f.onchange = async () => {
      const file = f.files[0];
      if (!file) return;

      const updateStatus = (msg) => s.textContent = msg;
      const updateProgress = (percent) => p.style.width = percent + '%';

      updateStatus('准备上传...');
      updateProgress(0);

      try {
        // 1. 初始化分片上传
        const initFd = new FormData();
        initFd.append('action', 'init');
        initFd.append('fileName', file.name);
        initFd.append('contentType', file.type);
        
        const initRes = await fetch('', { method: 'POST', body: initFd });
        if (!initRes.ok) throw new Error(await initRes.text());
        const { uploadId, key } = await initRes.json();
        
        console.log('Init success:', uploadId, key);

        // 2. 上传分片
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        const parts = [];

        for (let i = 0; i < totalChunks; i++) {
          const start = i * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, file.size);
          const chunk = file.slice(start, end);
          
          const partFd = new FormData();
          partFd.append('action', 'upload_part');
          partFd.append('uploadId', uploadId);
          partFd.append('key', key);
          partFd.append('partNumber', (i + 1).toString());
          partFd.append('file', chunk);

          updateStatus(\`正在上传分片 \${i + 1}/\${totalChunks}...\`);
          
          const partRes = await fetch('', { method: 'POST', body: partFd });
          if (!partRes.ok) throw new Error(await partRes.text());
          const { ETag } = await partRes.json();
          
          parts.push({ PartNumber: i + 1, ETag: ETag });
          
          updateProgress(((i + 1) / totalChunks) * 100);
        }

        // 3. 完成分片上传
        updateStatus('正在合并文件...');
        const completeFd = new FormData();
        completeFd.append('action', 'complete');
        completeFd.append('uploadId', uploadId);
        completeFd.append('key', key);
        completeFd.append('parts', JSON.stringify(parts));

        const completeRes = await fetch('', { method: 'POST', body: completeFd });
        if (!completeRes.ok) throw new Error(await completeRes.text());
        
        updateStatus('上传成功!');
        updateProgress(100);

      } catch (e) {
        console.error(e);
        updateStatus('错误: ' + e.message);
        p.style.backgroundColor = '#f44336';
      }
    };
  </script>
</body>
</html>`, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

export async function onRequestPost(context) {
  try {
    const s3Client = new S3Client({
      region: 'auto',
      endpoint: 'https://1e0e4cc333e3652263d97515cc3b4d2c.r2.cloudflarestorage.com',
      credentials: {
        accessKeyId: '15a003bd6fe5de5f784f98ab7ff29c30',
        secretAccessKey: '8349066d7f1d2dbd62d516cd1cc795bce1075321107b1f5c16b4a585b56d244b'
      },
      forcePathStyle: true
    });
    
    const formData = await context.request.formData();
    const action = formData.get('action');

    if (action === 'init') {
        const fileName = formData.get('fileName');
        const contentType = formData.get('contentType');
        
        // 生成文件名逻辑
        const ip = context.clientIp || 'unknown';
        const originalName = fileName;
        const dotIndex = originalName.lastIndexOf('.');
        const baseName = dotIndex > 0 ? originalName.substring(0, dotIndex) : originalName;
        const extension = dotIndex > 0 ? originalName.substring(dotIndex) : '';
        const ipName = (ip || 'unknown')
          .replace(/[.:]/g, '_')
          .replace(/_+/g, '_')
          .replace(/^_+|_+$/g, '');
        const salt = Math.random().toString(36).slice(2, 8);
        const newFileName = `${baseName}_${ipName}_${salt}${extension}`;

        const command = new CreateMultipartUploadCommand({
            Bucket: 'test',
            Key: `UnknownUpload/${newFileName}`,
            ContentType: contentType || 'application/octet-stream'
        });

        const result = await s3Client.send(command);
        return new Response(JSON.stringify({ 
            uploadId: result.UploadId, 
            key: result.Key 
        }), { headers: { 'Content-Type': 'application/json' } });

    } else if (action === 'upload_part') {
        const uploadId = formData.get('uploadId');
        const key = formData.get('key');
        const partNumber = parseInt(formData.get('partNumber'));
        const file = formData.get('file');
        
        if (!file) throw new Error('No file part provided');
        
        const fileBuffer = Buffer.from(await file.arrayBuffer());

        const command = new UploadPartCommand({
            Bucket: 'test',
            Key: key,
            UploadId: uploadId,
            PartNumber: partNumber,
            Body: fileBuffer
        });

        const result = await s3Client.send(command);
        return new Response(JSON.stringify({ ETag: result.ETag }), { headers: { 'Content-Type': 'application/json' } });

    } else if (action === 'complete') {
        const uploadId = formData.get('uploadId');
        const key = formData.get('key');
        const partsStr = formData.get('parts');
        let parts;
        try {
             parts = JSON.parse(partsStr);
        } catch(e) {
             throw new Error('Invalid parts JSON');
        }
        
        // 确保parts按PartNumber排序
        parts.sort((a, b) => a.PartNumber - b.PartNumber);

        const command = new CompleteMultipartUploadCommand({
            Bucket: 'test',
            Key: key,
            UploadId: uploadId,
            MultipartUpload: { Parts: parts }
        });

        await s3Client.send(command);
        return new Response('上传成功', { status: 200 });
    }
    
    return new Response('Invalid action', { status: 400 });
    
  } catch (error) {
    console.error('上传错误:', error);
    return new Response(`上传失败: ${error.message}`, { status: 500 });
  }
}