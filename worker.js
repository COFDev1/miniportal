export default {
  async fetch(request, env) {
    // Configuração mantida da versão original.
    const ALLOWED_ORIGIN = "https://jessealvessilva.github.io";
    const ROTAS = {
      "/valida-cliente": "https://sua-api.na-cloudflare.com/rest/valida-cliente",
      "/lista-pedidos": "https://app02.centraloftalmica.com.br/rest/app/contact/01052901"
    };

    const corsHeaders = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" };
    const responder = (status, erro) => new Response(JSON.stringify({ erro }), {
      status, headers: jsonHeaders
    });

    const url = new URL(request.url);
    const destino = ROTAS[url.pathname];
    if (!destino) return responder(404, "Rota não encontrada");

    if (request.method === "OPTIONS") {
      if (request.headers.get("Origin") !== ALLOWED_ORIGIN) {
        return responder(403, "Origem não permitida");
      }
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== "POST") {
      const response = responder(405, "Método não permitido");
      response.headers.set("Allow", "POST, OPTIONS");
      return response;
    }

    if (!env.PROTHEUS_USER || !env.PROTHEUS_PASS) {
      console.error("Credenciais do Protheus não configuradas nos Secrets.");
      return responder(500, "Erro interno de configuração");
    }

    try {
      const body = await request.text();
      const credentials = btoa(`${env.PROTHEUS_USER}:${env.PROTHEUS_PASS}`);
      const respProtheus = await fetch(destino, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${credentials}`,
          "Accept": "application/json"
        },
        body
      });

      // Repassa status e corpo, sem expor cabeçalhos internos do backend.
      const headers = new Headers(corsHeaders);
      const contentType = respProtheus.headers.get("Content-Type");
      if (contentType) headers.set("Content-Type", contentType);
      return new Response(respProtheus.body, {
        status: respProtheus.status,
        headers
      });
    } catch (err) {
      console.error("Falha na comunicação com o Protheus:", err);
      return responder(502, "Falha na comunicação com o serviço");
    }
  }
};
