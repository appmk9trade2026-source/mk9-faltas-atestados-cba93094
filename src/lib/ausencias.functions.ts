export const updateAusencia = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => {
    try {
      return updatePayloadSchema.parse(data);
    } catch (e) {
      throw toInvalidPayload(e);
    }
  })
  .handler(async ({ data, context }) => {
    // ============================================================
    // DIAGNÓSTICO DE BUILD / DEPLOY
    // Se este log não aparecer no Lovable Cloud Logs durante
    // uma edição, o domínio publicado está executando código antigo.
    // ============================================================
    console.info("[MK9_UPDATE_BUILD]", {
      version: "2026-09-03-UPDATED-AT-V3",
      ausencia_id: data.id,
      user_id: context.userId,
    });

    const isManual = data.origem_registro === "MANUAL";
    const request = getRequest();
    const meta = resolveOperationMetadata(request);

    // ============================================================
    // 1. CARREGAR REGISTRO ATUAL
    // ============================================================
    const { data: current, error: loadErr } = await context.supabase
      .from("ausencias")
      .select(
        "id, empresa_id, projeto_id, colaborador_id, origem_registro, status, tipo, tipo_detalhe, dias, motivo, cid, data_inicio, data_fim, localidade, loja_codigo_nome, acidente_trabalho_trajeto, arquivo_url, arquivo_nome, arquivo_mime, arquivo_tamanho, hash_integridade, updated_at",
      )
      .eq("id", data.id)
      .maybeSingle();

    if (loadErr) {
      console.error("[MK9_UPDATE_LOAD_ERROR]", {
        ausencia_id: data.id,
        code: loadErr.code ?? null,
        message: loadErr.message,
      });

      throw new Error(
        `RESOURCE_NOT_FOUND: Não foi possível carregar a ausência para edição.`,
      );
    }

    if (!current) {
      throw new Error(
        "RESOURCE_NOT_FOUND: ausência não encontrada",
      );
    }

    // ============================================================
    // 2. GUARD DE STATUS
    // ============================================================
    if (current.status !== "PENDENTE") {
      throw new Error(
        `CONFLICT: Este registro está com status ${current.status} e não está disponível para edição direta.`,
      );
    }

    // ============================================================
    // 3. ORIGEM É IMUTÁVEL
    // ============================================================
    if (
      (current.origem_registro ?? "AUTOMATICO") !==
      data.origem_registro
    ) {
      throw new Error(
        "INVALID_PAYLOAD: a origem do registro não pode ser alterada",
      );
    }

    // ============================================================
    // 4. COLABORADOR É IMUTÁVEL EM AUTOMÁTICO
    // ============================================================
    if (
      !isManual &&
      data.colaborador_id !== current.colaborador_id
    ) {
      throw new Error(
        "INVALID_PAYLOAD: colaborador não pode ser alterado após criação",
      );
    }

    // ============================================================
    // 5. EMPRESA/PROJETO SÃO IMUTÁVEIS EM MANUAL
    // ============================================================
    if (
      isManual &&
      (
        data.projeto_id !== current.projeto_id ||
        data.empresa_id !== current.empresa_id
      )
    ) {
      throw new Error(
        "INVALID_PAYLOAD: empresa/projeto não podem ser alterados após criação",
      );
    }

    // ============================================================
    // 6. RBAC / ESCOPO
    // ============================================================
    const gate = await requirePermission({
      ctx: context,
      permission: PERMISSION_MAP.updateAbsence,

      colaboradorId: isManual
        ? null
        : (current.colaborador_id as string),

      projetoId: isManual
        ? (current.projeto_id as string)
        : null,

      route: "/nova-ausencia",
    });

    console.info("[MK9_UPDATE_GATE_PASS]", {
      ausencia_id: data.id,
      correlation_id: gate.correlationId,
      empresa_id: gate.empresaId ?? null,
      projeto_id: gate.projetoId ?? null,
    });

    // ============================================================
    // 7. HIDRATAR TIPO E PERÍODO
    // ============================================================
    const [tipoRes, opcaoRes] = await Promise.all([
      context.supabase
        .from("tipos_ausencia" as never)
        .select("codigo, nome, ativo")
        .eq("id", data.tipo_ausencia_id)
        .maybeSingle(),

      context.supabase
        .from("opcoes_periodo_ausencia" as never)
        .select("codigo, nome, quantidade_dias")
        .eq("id", data.opcao_periodo_id)
        .maybeSingle(),
    ]);

    const tipo = tipoRes.data as {
      codigo: string;
      nome: string;
      ativo: boolean;
    } | null;

    const opcao = opcaoRes.data as {
      codigo: string;
      nome: string;
      quantidade_dias: number | null;
    } | null;

    if (!tipo?.ativo) {
      throw new Error(
        "INVALID_PAYLOAD: tipo inválido",
      );
    }

    if (!opcao) {
      throw new Error(
        "INVALID_PAYLOAD: opção de período inválida",
      );
    }

    // ============================================================
    // 8. CALCULAR DATA FINAL
    // ============================================================
    const dias = opcao.quantidade_dias ?? 1;

    const dataFim = new Date(
      data.data_inicio + "T00:00:00",
    );

    dataFim.setDate(
      dataFim.getDate() +
        Math.max(dias - 1, 0),
    );

    const tipoBase =
      tipo.codigo.startsWith("ATESTADO")
        ? "ATESTADO"
        : tipo.codigo.startsWith("DECLARACAO")
          ? "DECLARACAO"
          : tipo.codigo.startsWith("FALTA")
            ? "FALTA"
            : tipo.codigo.startsWith("SUSPENSAO")
              ? "SUSPENSAO"
              : "OUTROS";

    // ============================================================
    // 9. ACIDENTE DE TRABALHO
    // ============================================================
    const isAcidenteU =
      tipo.codigo === "ACIDENTE_TRABALHO";

    if (isAcidenteU) {
      if (
        !data.acidente_data ||
        !data.acidente_hora ||
        !data.acidente_local?.trim() ||
        !data.acidente_descricao?.trim()
      ) {
        throw new Error(
          "INVALID_PAYLOAD: Acidente exige data, hora, local e descrição",
        );
      }
    }

    // ============================================================
    // 10. DADOS MANUAIS EDITÁVEIS
    // ============================================================
    const manualUpdate = isManual
      ? (() => {
          const {
            manual_registrado_por: _p,
            manual_registrado_em: _e,
            ...rest
          } = manualColumns(
            data,
            gate.userId,
          );

          return rest;
        })()
      : {};

    // ============================================================
    // 11. PAYLOAD CANÔNICO DO UPDATE
    //
    // IMPORTANTE:
    // NÃO EXISTE atualizado_em em public.ausencias.
    // A coluna correta é updated_at.
    // ============================================================
    const updatePayload = {
      ...manualUpdate,

      tipo: tipoBase,
      tipo_detalhe: tipo.nome,
      dias_label: opcao.nome,

      tipo_ausencia_id:
        data.tipo_ausencia_id,

      opcao_periodo_id:
        data.opcao_periodo_id,

      motivo: data.motivo,

      data_inicio:
        data.data_inicio,

      data_fim:
        dataFim
          .toISOString()
          .slice(0, 10),

      localidade:
        data.localidade,

      loja_codigo_nome:
        data.loja_codigo_nome,

      cid:
        data.cid && data.cid.trim()
          ? data.cid
              .trim()
              .toUpperCase()
          : null,

      acidente_trabalho_trajeto:
        data.acidente_trabalho_trajeto,

      horario_inicio:
        data.horario_inicio ?? null,

      horario_fim:
        data.horario_fim ?? null,

      arquivo_url:
        data.arquivo_url ??
        current.arquivo_url,

      arquivo_nome:
        data.arquivo_nome ??
        current.arquivo_nome,

      arquivo_mime:
        data.arquivo_mime ??
        current.arquivo_mime,

      arquivo_tamanho:
        data.arquivo_tamanho ??
        current.arquivo_tamanho,

      // ========================================================
      // AUTORIA CANÔNICA
      // ========================================================
      atualizado_por_usuario_id:
        context.userId,

      // ========================================================
      // TIMESTAMP CANÔNICO
      // NÃO TROCAR POR atualizado_em
      // ========================================================
      updated_at:
        new Date().toISOString(),

      // ========================================================
      // AUDITORIA FORENSE
      // ========================================================
      operacao_origem:
        "WEB",

      operacao_ip:
        meta.ip,

      operacao_user_agent:
        meta.userAgent,

      operacao_sistema_operacional:
        meta.os,

      operacao_navegador:
        meta.browser,

      operacao_dispositivo_tipo:
        meta.deviceType,

      operacao_timestamp_utc:
        new Date().toISOString(),

      ...(isAcidenteU
        ? {
            acidente_data:
              data.acidente_data,

            acidente_hora:
              data.acidente_hora,

            acidente_local:
              data.acidente_local?.trim() ??
              null,

            acidente_descricao:
              data.acidente_descricao?.trim() ??
              null,

            acidente_atendimento_medico:
              data.acidente_atendimento_medico ??
              null,

            acidente_houve_afastamento:
              data.acidente_houve_afastamento ??
              null,

            acidente_dias_afastamento_inicial:
              data.acidente_dias_afastamento_inicial !=
              null
                ? parseInt(
                    String(
                      data.acidente_dias_afastamento_inicial,
                    ),
                  ) || 0
                : null,

            acidente_cat_emitida:
              data.acidente_cat_emitida ??
              null,

            acidente_observacoes:
              data.acidente_observacoes?.trim() ??
              null,
          }
        : {}),
    };

    console.info("[MK9_UPDATE_PAYLOAD]", {
      version:
        "2026-09-03-UPDATED-AT-V3",

      ausencia_id:
        data.id,

      correlation_id:
        gate.correlationId,

      payload_keys:
        Object.keys(updatePayload),

      has_updated_at:
        Object.prototype.hasOwnProperty.call(
          updatePayload,
          "updated_at",
        ),

      has_atualizado_em:
        Object.prototype.hasOwnProperty.call(
          updatePayload,
          "atualizado_em",
        ),
    });

    // ============================================================
    // 12. HASH DE INTEGRIDADE
    // ============================================================
    const newHash =
      calculateIntegrityHash(
        updatePayload,
        current.hash_integridade,
      );

    (updatePayload as any).hash_integridade =
      newHash;

    (updatePayload as any).hash_atual =
      newHash;

    (updatePayload as any).hash_anterior =
      current.hash_integridade;

    // ============================================================
    // 13. AUDITORIA DE CAMPOS
    // ============================================================
    const fieldsToAudit = [
      "tipo_ausencia_id",
      "opcao_periodo_id",
      "motivo",
      "data_inicio",
      "data_fim",
      "localidade",
      "loja_codigo_nome",
      "cid",
      "acidente_trabalho_trajeto",
      "horario_inicio",
      "horario_fim",
      "arquivo_url",
    ];

    const audits = [];

    const snapshot =
      await getSnapshot(
        context.supabase,
        context.userId,
      );

    for (
      const field of
      fieldsToAudit
    ) {
      const oldVal =
        (current as any)[field];

      const newVal =
        (updatePayload as any)[field];

      if (oldVal !== newVal) {
        audits.push({
          ausencia_id:
            data.id,

          campo:
            field,

          valor_anterior:
            oldVal,

          valor_novo:
            newVal,

          responsavel_usuario_id:
            context.userId,

          responsavel_nome:
            snapshot?.nome,

          responsavel_papel:
            snapshot?.papel,

          correlation_id:
            gate.correlationId,
        });
      }
    }

    if (audits.length > 0) {
      const {
        error: auditFieldError,
      } = await context.supabase
        .from("ausencia_field_audit")
        .insert(audits);

      if (auditFieldError) {
        console.error(
          "[MK9_UPDATE_FIELD_AUDIT_ERROR]",
          {
            ausencia_id:
              data.id,

            correlation_id:
              gate.correlationId,

            code:
              auditFieldError.code ??
              null,

            message:
              auditFieldError.message,
          },
        );

        throw ausenciaDbError(
          auditFieldError,
          "update_ausencia",
          gate.correlationId,
        );
      }
    }

    // ============================================================
    // 14. UPDATE REAL
    // ============================================================
    console.info(
      "[MK9_UPDATE_DB_START]",
      {
        version:
          "2026-09-03-UPDATED-AT-V3",

        ausencia_id:
          data.id,

        correlation_id:
          gate.correlationId,
      },
    );

    const {
      data: updated,
      error,
    } = await context.supabase
      .from("ausencias")
      .update(
        updatePayload as never,
      )
      .eq(
        "id",
        data.id,
      )
      .eq(
        "status",
        "PENDENTE",
      )
      .select(
        "id, status, updated_at",
      )
      .maybeSingle();

    if (error) {
      console.error(
        "[MK9_UPDATE_DB_ERROR]",
        {
          version:
            "2026-09-03-UPDATED-AT-V3",

          ausencia_id:
            data.id,

          correlation_id:
            gate.correlationId,

          code:
            error.code ??
            null,

          message:
            error.message,

          details:
            error.details ??
            null,

          hint:
            error.hint ??
            null,
        },
      );

      throw ausenciaDbError(
        error,
        "update_ausencia",
        gate.correlationId,
      );
    }

    if (!updated) {
      console.warn(
        "[MK9_UPDATE_ZERO_ROW]",
        {
          ausencia_id:
            data.id,

          correlation_id:
            gate.correlationId,

          previous_status:
            current.status,
        },
      );

      throw new Error(
        "CONFLICT: Este registro não está mais disponível para edição. Atualize a página e verifique o status atual.",
      );
    }

    console.info(
      "[MK9_UPDATE_DB_SUCCESS]",
      {
        version:
          "2026-09-03-UPDATED-AT-V3",

        ausencia_id:
          updated.id,

        status:
          updated.status,

        updated_at:
          updated.updated_at,

        correlation_id:
          gate.correlationId,
      },
    );

    // ============================================================
    // 15. AUDITORIA PRINCIPAL
    // ============================================================
    await audit(
      context.supabase,
      "AUSENCIA_EDITADA",
      data.id,
      gate.correlationId,

      {
        tipo:
          current.tipo,

        tipo_detalhe:
          current.tipo_detalhe,

        motivo:
          current.motivo,

        cid:
          current.cid,

        data_inicio:
          current.data_inicio,

        data_fim:
          current.data_fim,

        localidade:
          current.localidade,

        loja_codigo_nome:
          current.loja_codigo_nome,

        acidente_trabalho_trajeto:
          current.acidente_trabalho_trajeto,
      },

      {
        tipo:
          tipoBase,

        tipo_detalhe:
          tipo.nome,

        motivo:
          updatePayload.motivo,

        cid:
          updatePayload.cid,

        data_inicio:
          updatePayload.data_inicio,

        data_fim:
          updatePayload.data_fim,

        localidade:
          updatePayload.localidade,

        loja_codigo_nome:
          updatePayload.loja_codigo_nome,

        acidente_trabalho_trajeto:
          updatePayload.acidente_trabalho_trajeto,
      },

      "edição",

      gate.empresaId,
      gate.projetoId,
      context.userId,
    );

    // ============================================================
    // 16. NOTIFICAÇÃO
    // ============================================================
    const mudancaRelevante =
      current.data_inicio !==
        updatePayload.data_inicio ||
      current.data_fim !==
        updatePayload.data_fim ||
      current.tipo_detalhe !==
        updatePayload.tipo_detalhe;

    if (mudancaRelevante) {
      await enfileirarNotificacoesAusencia({
        supabase:
          context.supabase,

        ausenciaId:
          data.id,

        evento:
          "AUSENCIA_RETIFICADA",

        correlationId:
          gate.correlationId,

        userId:
          gate.userId,
      });
    }

    // ============================================================
    // 17. SUCESSO
    // ============================================================
    return {
      ok: true,

      id:
        updated.id,

      status:
        updated.status,

      updated_at:
        updated.updated_at,

      correlation_id:
        gate.correlationId,

      build:
        "2026-09-03-UPDATED-AT-V3",
    };
  });
