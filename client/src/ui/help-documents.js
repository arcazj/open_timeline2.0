import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function renderMarkdown(markdown) {
  return DOMPurify.sanitize(marked.parse(markdown, { async: false }), {
    ALLOWED_TAGS: ['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'pre', 'code', 'blockquote', 'em', 'strong', 'del', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'hr', 'br'],
    ALLOWED_ATTR: ['href', 'title'],
  });
}
export function documentTarget(href, currentPath, documents, projectUrl) {
  const base = 'https://docs.invalid/';
  const url = new URL(href, base + currentPath);
  if (url.origin === 'https://docs.invalid') {
    const path = decodeURIComponent(url.pathname.slice(1));
    if (documents[path]) return { document: path };
    return { url: `${projectUrl}/blob/main/${url.pathname.slice(1)}${url.hash}` };
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  return { url: url.href };
}

export function swaggerDocument(content) {
  const json = JSON.stringify(content.spec).replace(/</g, '\\u003c');
  const script = content.swagger.js.replace(/<\/script/gi, '<\\/script');
  const style = content.swagger.css.replace(/<\/style/gi, '<\\/style');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; base-uri 'none'; form-action 'none'"><style>${style}\nbody{margin:0;background:white}.swagger-ui .wrapper{padding:0 12px}.swagger-ui .info{margin:16px 0}.swagger-ui .scheme-container{display:none}.swagger-ui .auth-wrapper{display:none}</style></head><body><div id="swagger"></div><script>${script}\nSwaggerUIBundle({spec:${json},dom_id:'#swagger',validatorUrl:null,supportedSubmitMethods:[],tryItOutEnabled:false,persistAuthorization:false,queryConfigEnabled:false,deepLinking:false,defaultModelsExpandDepth:-1,docExpansion:'none',filter:true,displayRequestDuration:false});</script></body></html>`;
}
