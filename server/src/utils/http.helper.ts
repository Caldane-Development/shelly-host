import { IncomingMessage, RequestOptions } from 'http';
import { URL } from 'url';
import https from 'https';
import http from 'http';
import querystring from "querystring";
import { logger } from '../logger';

interface RequestOptionsWithProtocol extends RequestOptions {
  protocol: string;
}

async function makeRequest<T>(
  options: RequestOptionsWithProtocol,
  data: string | null = null,
  retries: number = 3,
  delay: number = 1000
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const requestLib = options.protocol === 'https:' ? https : http;
    const req = requestLib.request(options, (res: IncomingMessage) => {
      let responseData = '';

      res.on('data', (chunk) => {
        responseData += chunk;
      });

      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            const parsedResponse = JSON.parse(responseData);
            resolve(parsedResponse);
          } catch (e) {
            reject(new Error(`Invalid JSON response: ${responseData}`));
          }
        } else {
          reject(new Error(`HTTP Error ${res.statusCode}: ${responseData}`));
        }
      });
    });

    // Set a 2-second timeout
    req.setTimeout(2000, () => {
      req.destroy();
      reject(new Error(`Request timed out after 2 seconds`));
    });

    req.on('error', (err) => {
      if (retries > 0) {
        //console.log(`Retrying due to error: ${err.message}. Attempts left: ${retries - 1}`);
        setTimeout(async () => {
          try {
            const response = await makeRequest<T>(options, data, retries - 1, delay);
            resolve(response);  // Ensure the retried request resolves the parent promise
          } catch (retryError) {
            reject(retryError);
          }
        }, delay);
      } else {
        reject(new Error(`Failed after retries: ${err.message}`));
      }
    });

    if (data) {
      req.write(data);
    }

    req.end();
  });
}


async function getRequest<T>(
  url: string,
  headers: Record<string, string> = {},
  retries: number = 3,
  delay: number = 1000
): Promise<T> {
  const options: RequestOptionsWithProtocol = new URL(url);
  options.method = 'GET';
  options.headers = headers;

  try {
    const response = await makeRequest<T>(options, null, retries, delay);
    logger.debug(`GET response: ${JSON.stringify(response)}`);
    return response;
  } catch (error) {
    logger.debug(`GET request failed: ${error}`);
    throw error;
  }
}

async function postRequest<T>(
  url: string,
  headers: Record<string, string | number> = {},
  data: Record<string, unknown> = {},
  retries: number = 3,
  delay: number = 1000
): Promise<T> {
  const options: RequestOptionsWithProtocol = new URL(url);
  options.method = 'POST';
  options.headers = {
    ...headers,
  };

  let body: string;
  if (headers['Content-Type'] === 'application/x-www-form-urlencoded') {
    body = querystring.stringify(data as Record<string, string | number | boolean | readonly string[] | readonly number[] | readonly boolean[] | null>);
  } else {
    body = JSON.stringify(data);
    headers['Content-Type'] = 'application/json'; 
  }

  headers['Content-Length'] = Buffer.byteLength(body); 

  try {
    logger.debug(`POST request to ${url} with body: ${body} `);
    const response = await makeRequest<T>(options, body, retries, delay);
    logger.debug(`POST response: ${JSON.stringify(response)}`);
    return response;
  } catch (error) {
    logger.debug(`POST request failed: ${error}`);
    throw error;
  }
}

export { getRequest, postRequest };
