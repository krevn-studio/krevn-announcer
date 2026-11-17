import type {IncomingMessage, ServerResponse} from 'node:http'
import {resetState, runCheck} from './krevn.ts'

// Solo due rotte: il controllo giornaliero e l'installazione (che non crea post).
export async function onReq(reqMsg: IncomingMessage, rspMsg: ServerResponse): Promise<void> {
  const path = reqMsg.url?.split('?')[0]
  try {
    if (reqMsg.method === 'POST' && path === '/internal/scheduler/krevn-check') {
      const log = await runCheck()
      console.log(log.join('\n') || 'nessuna novità')
      return writeJson(200, {status: 'ok'}, rspMsg)
    }
    if (reqMsg.method === 'POST' && path === '/internal/on/menu/check-now') {
      let text: string
      try { text = (await runCheck()).join(' · ') || 'Nessuna novità' }
      catch (err) { console.error(err); text = 'Errore: ' + (err instanceof Error ? err.message : String(err)) }
      return writeJson(200, {showToast: {text: text.slice(0, 250)}}, rspMsg)
    }
    if (reqMsg.method === 'POST' && path === '/internal/on/menu/reset') {
      await resetState()
      return writeJson(200, {showToast: {text: 'Stato azzerato. Premi "Krevn: controlla ora" per ripubblicare il lancio.'}}, rspMsg)
    }
    if (reqMsg.method === 'POST' && path === '/internal/on/app/install') {
      return writeJson(200, {}, rspMsg)
    }
    writeJson(404, {error: `not found: ${reqMsg.method} ${reqMsg.url}`, status: 404}, rspMsg)
  } catch (err) {
    const msg = `server error; ${err instanceof Error ? err.stack : err}`
    console.error(msg)
    writeJson(500, {error: msg, status: 500}, rspMsg)
  }
}

function writeJson(status: number, json: object, rsp: ServerResponse): void {
  const body = JSON.stringify(json)
  rsp.writeHead(status, {'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json'})
  rsp.end(body)
}
