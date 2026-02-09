
import http from 'http';

const OLLAMA_HOST = process.env.OLLAMA_HOST || '127.0.0.1';
const OLLAMA_PORT = process.env.OLLAMA_PORT || 11434;

async function checkOllama() {
    console.log(`Checking Ollama at http://${OLLAMA_HOST}:${OLLAMA_PORT}...`);

    const data = JSON.stringify({
        model: 'tinyllama',
        prompt: 'Hello, are you there?',
        stream: false
    });

    const options = {
        hostname: OLLAMA_HOST,
        port: OLLAMA_PORT,
        path: '/api/generate',
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Content-Length': data.length
        }
    };

    const req = http.request(options, (res) => {
        let responseBody = '';

        res.on('data', (chunk) => {
            responseBody += chunk;
        });

        res.on('end', () => {
            if (res.statusCode === 200) {
                try {
                    const json = JSON.parse(responseBody);
                    console.log('Success! Response from Ollama:');
                    console.log(json.response);
                } catch (e) {
                    console.error('Failed to parse JSON response:', e);
                }
            } else {
                console.error(`Error: Ollama returned status code ${res.statusCode}`);
                console.error('Response:', responseBody);
                if (res.statusCode === 404) {
                    console.error("Model 'tinyllama' not found. Try 'ollama pull tinyllama'");
                }
            }
        });
    });

    req.on('error', (error) => {
        console.error('Error connecting to Ollama:', error.message);
        console.error('Make sure Ollama is running (default port 11434).');
    });

    req.write(data);
    req.end();
}

checkOllama();
