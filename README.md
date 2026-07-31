# Ghost WhatsApp Bridge 1.0.0

Serviço privado que mantém uma sessão do WhatsApp Web conectada por QR Code e recebe solicitações assinadas do Send Code Woo.

## Requisitos

- VPS ou servidor com Docker; ou Node.js 18+ e Chromium.
- Um endereço HTTPS acessível pelo WordPress, salvo quando o serviço roda na mesma máquina e é acessado por `http://127.0.0.1:8787`.
- A pasta `data` precisa ser persistente. Ela armazena a sessão conectada.

## Instalação com Docker

1. Extraia os arquivos no servidor.
2. Copie `.env.example` para `.env`.
3. Crie um segredo com pelo menos 32 caracteres. Exemplo:

   ```bash
   openssl rand -hex 32
   ```

4. Coloque o resultado em `SHARED_SECRET` no `.env`.
5. Inicie:

   ```bash
   docker compose up -d --build
   ```

6. Teste localmente:

   ```bash
   curl http://127.0.0.1:8787/health
   ```

7. Publique com HTTPS usando Nginx, CloudPanel, EasyPanel, Traefik ou outro proxy reverso. Há um exemplo em `nginx-example.conf`.
8. No WordPress, abra **Send Code Woo → WhatsApp por QR Code**, informe:
   - o endereço HTTPS do serviço;
   - exatamente o mesmo `SHARED_SECRET`;
   - o telefone para teste.
9. Salve, aguarde o QR Code e escaneie em **WhatsApp → Aparelhos conectados → Conectar aparelho**.

## Segurança

- As rotas privadas usam assinatura HMAC com validade de cinco minutos.
- O conteúdo das mensagens não é gravado nos logs do serviço.
- Solicitações de envio usam identificadores idempotentes para evitar mensagens duplicadas.
- Não exponha a porta 8787 diretamente à internet; use HTTPS e firewall.
- Faça backup da pasta `data`, mas mantenha-a privada.

## Comandos úteis

```bash
docker compose logs -f
docker compose restart
docker compose down
```

Para apagar a sessão e gerar outro QR Code, use o botão **Desconectar** no WordPress.


## Versão 1.0.1

- Resolve o identificador real do destinatário com `getNumberId()` antes do envio.
- Trata a diferença do nono dígito em números brasileiros.
- Retorna uma mensagem clara quando o número não está registrado no WhatsApp.
