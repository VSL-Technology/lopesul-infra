# Relay Inteligente - Multi-Mikrotik por Dispositivo

## Visão Geral

O relay agora suporta **modo inteligente** que consulta o banco de dados diretamente para determinar qual Mikrotik usar, baseado em `pedidoId` ou `deviceId/mikId`. Isso centraliza a lógica de roteamento no relay e simplifica o backend.

## Funcionalidades

### Modo Inteligente (Novo)
- **`/relay/exec-by-pedido`**: Busca o dispositivo automaticamente pelo `pedidoId`
- **`/relay/exec-by-device`**: Busca o dispositivo por `deviceId` ou `mikId`
- **Cache**: Dispositivos são cacheados por 60 segundos para melhor performance
- **Fallback automático**: Se o banco não estiver disponível, usa modo direto

### Modo Direto (Compatibilidade)
- **`/relay/exec`**: Mantém compatibilidade com o modo antigo (host/user/pass direto)

## Setup

### 1. Instalar Dependências

```bash
cd /opt/lopesul-infra/relay
npm install
```

### 2. Configurar Prisma

O relay precisa do Prisma Client gerado. Você tem duas opções:

#### Opção A: Usar schema do dashboard (recomendado)
```bash
# No diretório do dashboard
cd /opt/lopesul-dashboard
npx prisma generate

# Copiar o Prisma Client gerado para o relay
cp -r node_modules/@prisma/client /opt/lopesul-infra/relay/node_modules/@prisma/client
cp -r node_modules/.prisma /opt/lopesul-infra/relay/node_modules/.prisma
```

#### Opção B: Gerar Prisma Client no relay
```bash
cd /opt/lopesul-infra/relay
# Criar link simbólico para o schema
ln -s ../lopesul-dashboard/prisma/schema.prisma prisma/schema.prisma
npx prisma generate --schema=prisma/schema.prisma
```

### 3. Configurar Variáveis de Ambiente

Adicione ao `.env` do relay:

```env
DATABASE_URL=postgresql://user:pass@host:port/database
RELAY_TOKEN=seu-token-aqui
```

### 4. Reiniciar o Relay

```bash
pm2 restart mikrotik-relay
```

## Uso

### Backend (Next.js)

O backend agora tenta usar o modo inteligente automaticamente quando `pedidoId`, `deviceId` ou `mikId` estão disponíveis:

```javascript
import { liberarAcesso } from '@/lib/mikrotik';

// Modo inteligente (prioridade)
await liberarAcesso({
  ip: '10.200.200.100',
  mac: 'AA:BB:CC:DD:EE:FF',
  pedidoId: 'pedido-123', // ← Ativa modo inteligente
  deviceId: 'device-456', // ← Ativa modo inteligente
  mikId: 'MIK-BUS-06',    // ← Ativa modo inteligente
  router: { ... },        // ← Fallback se modo inteligente falhar
});
```

### API Direta

```bash
# Modo inteligente por pedido
curl -X POST http://localhost:3001/relay/exec-by-pedido \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pedidoId": "pedido-123",
    "command": "/ip/hotspot/active/print"
  }'

# Modo inteligente por device
curl -X POST http://localhost:3001/relay/exec-by-device \
  -H "Authorization: Bearer $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "deviceId": "device-456",
    "command": "/ip/hotspot/active/print"
  }'
```

## Fluxo de Decisão

```
liberarAcesso() chamado
    ↓
Tem pedidoId/deviceId/mikId?
    ├─ SIM → Tenta /relay/exec-by-pedido ou /relay/exec-by-device
    │         ├─ Sucesso → Retorna (modo inteligente)
    │         └─ Falha (DB indisponível) → Continua para modo direto
    │
    └─ NÃO → Usa modo direto (/relay/exec com host/user/pass)
             ├─ Sucesso → Retorna (modo direto)
             └─ Falha → Fallback para API direta (mikronode-ng2)
```

## Cache

- **TTL**: 60 segundos
- **Chave**: `pedido:{pedidoId}` ou `device:{deviceId}`
- **Benefício**: Reduz consultas ao banco em requisições frequentes

## Logs

O relay registra:
- `[relay] Prisma Client inicializado (modo inteligente ativo)` - Modo inteligente ativo
- `[relay] DATABASE_URL não configurado - modo inteligente desabilitado` - Modo inteligente desabilitado
- `[relay] Modo inteligente: ATIVO/DESATIVADO` - Status na inicialização

## Troubleshooting

### "database_not_available"
- Verifique se `DATABASE_URL` está configurado no `.env` do relay
- Verifique se o Prisma Client foi gerado corretamente

### "device_not_found"
- Verifique se o `pedidoId` ou `deviceId` existe no banco
- Verifique se o dispositivo tem `mikrotikHost`, `mikrotikUser`, `mikrotikPass` preenchidos

### Modo inteligente não funciona
- O relay faz fallback automático para modo direto
- Verifique os logs do relay para identificar o problema

## Compatibilidade

✅ **Totalmente compatível** com código existente:
- Se não passar `pedidoId`/`deviceId`, usa modo direto
- Se modo inteligente falhar, faz fallback para modo direto
- Se modo direto falhar, faz fallback para API direta

