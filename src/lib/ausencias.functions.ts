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
    const BUILD_VERSION = "2026-09-03-UPDATED-AT-V5";

    console.info("[MK9_UPDATE_BUILD]", {
      version: BUILD_VERSION,
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
        [
          "id",
          "empresa_id",
          "projeto_id",
          "colaborador_id",
          "origem_registro",
          "status",
          "tipo",
          "tipo_detalhe",
          "dias",
          "motivo",
          "cid",
          "data_inicio",
          "data_fim",
          "localidade",
          "loja_codigo_nome",
          "acidente_trabalho_trajeto",
          "arquivo_url",
          "arquivo_nome",
          "arquivo_mime",
          "arquivo_tamanho",
          "hash_integridade",
          "updated_at",
        ].join(", "),
      )
      .eq("id", data.id)
      .maybeSingle();

    if (loadErr) {
      console.error("[MK9_UPDATE_LOAD_ERROR]", {
        version: BUILD_VERSION,
        ausencia_id: data.id,
        code: loadErr.code ?? null,
        message: loadErr.message,
        details: loadErr.details ?? null,
        hint: loadErr.hint ?? null,
      });

      throw new Error(
        "RESOURCE_NOT_FOUND: Não foi possível carregar a ausência para edição.",
      );
    }

    if (!current) {
      throw new Error(
        "RESOURCE_NOT_FOUND: ausência não encontrada",
      );
    }

    // ============================================================
    // 2. STATUS
    // Apenas registros PENDENTE podem ser alterados diretamente.
    // ============================================================

    if (current.status !== "PENDENTE") {
      throw new Error(
        `CONFLICT: Este registro está com status ${current.status} e não está disponível para edição direta.`,
      );
    }

    // ============================================================
    // 3. ORIGEM IMUTÁVEL
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
    // 4. COLABORADOR IMUTÁVEL EM REGISTRO AUTOMÁTICO
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
    // 5. EMPRESA/PROJETO IMUTÁVEIS EM REGISTRO MANUAL
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
      version: BUILD_VERSION,
      ausencia_id: data.id,
      correlation_id: gate.correlationId,
      empresa_id: gate.empresaId ?? null,
      projeto_id: gate.projetoId ?? null,
    });

    // ============================================================
    // 7. CARREGAR TIPO E PERÍODO
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

    if (tipoRes.error) {
      console.error("[MK9_UPDATE_TIPO_ERROR]", {
        version: BUILD_VERSION,
        ausencia_id: data.id,
        correlation_id: gate.correlationId,
        message: tipoRes.error.message,
      });

      throw new Error(
        `TECHNICAL_ERROR: Não foi possível validar o tipo da ausência. Código de suporte: ${gate.correlationId}`,
      );
    }

    if (opcaoRes.error) {
      console.error("[MK9_UPDATE_PERIODO_ERROR]", {
        version: BUILD_VERSION,
        ausencia_id: data.id,
        correlation_id: gate.correlationId,
        message: opcaoRes.error.message,
      });

      throw new Error(
        `TECHNICAL_ERROR: Não foi possível validar o período da ausência. Código de suporte: ${gate.correlationId}`,
      );
    }

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
        "INVALID_PAYLOAD: tipo inválido ou inativo",
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
      `${data.data_inicio}T00:00:00`,
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
    // 10. CAMPOS MANUAIS
    // ============================================================

    const manualUpdate = isManual
      ? (() => {
          const {
            manual_registrado_por: _manualRegistradoPor,
            manual_registrado_em: _manualRegistradoEm,
            ...rest
          } = manualColumns(
            data,
            gate.userId,
          );

          return rest;
        })()
      : {};

    // ============================================================
    // 11. PAYLOAD CANÔNICO
    //
    // public.ausencias:
    // ✅ updated_at
    // ✅ atualizado_por_usuario_id
    // ❌ atualizado_em
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

      motivo:
        data.motivo,

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
        data.cid?.trim()
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

      atualizado_por_usuario_id:
        context.userId,

      updated_at:
        new Date().toISOString(),

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
                    10,
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

    // ============================================================
    // 12. SANITIZAÇÃO DEFENSIVA
    // ============================================================

    const sanitizedUpdatePayload = {
      ...updatePayload,
    } as Record<string, unknown>;

    // Guardrail crítico:
    // essa coluna NÃO existe em public.ausencias.
    delete sanitizedUpdatePayload.atualizado_em;

    sanitizedUpdatePayload.updated_at =
      new Date().toISOString();

    sanitizedUpdatePayload.atualizado_por_usuario_id =
      context.userId;

    // ============================================================
    // 13. ASSERTIVA DE CONTRATO
    // ============================================================

    if (
      Object.prototype.hasOwnProperty.call(
        sanitizedUpdatePayload,
        "atualizado_em",
      )
    ) {
      console.error("[MK9_UPDATE_SCHEMA_GUARD_FAIL]", {
        version: BUILD_VERSION,
        ausencia_id: data.id,
        correlation_id: gate.correlationId,
      });

      throw new Error(
        `TECHNICAL_ERROR: Payload incompatível com o schema de ausências. Código de suporte: ${gate.correlationId}`,
      );
    }

    console.info("[MK9_UPDATE_PAYLOAD]", {
      version: BUILD_VERSION,
      ausencia_id: data.id,
      correlation_id: gate.correlationId,

      has_updated_at:
        Object.prototype.hasOwnProperty.call(
          sanitizedUpdatePayload,
          "updated_at",
        ),

      has_atualizado_em:
        Object.prototype.hasOwnProperty.call(
          sanitizedUpdatePayload,
          "atualizado_em",
        ),

      payload_keys:
        Object.keys(
          sanitizedUpdatePayload,
        ),
    });

    // ============================================================
    // 14. HASH DE INTEGRIDADE
    // ============================================================

    const newHash =
      calculateIntegrityHash(
        sanitizedUpdatePayload,
        current.hash_integridade,
      );

    sanitizedUpdatePayload.hash_integridade =
      newHash;

    sanitizedUpdatePayload.hash_atual =
      newHash;

    sanitizedUpdatePayload.hash_anterior =
      current.hash_integridade;

    // ============================================================
    // 15. AUDITORIA FIELD-LEVEL
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

    const audits: Array<Record<string, unknown>> = [];

    const snapshot =
      await getSnapshot(
        context.supabase,
        context.userId,
      );

    for (const field of fieldsToAudit) {
      const oldVal =
        (current as any)[field];

      const newVal =
        sanitizedUpdatePayload[field];

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
            snapshot?.nome ?? null,

          responsavel_papel:
            snapshot?.papel ?? null,

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
        .insert(audits as never);

      if (auditFieldError) {
        console.error(
          "[MK9_UPDATE_FIELD_AUDIT_ERROR]",
          {
            version:
              BUILD_VERSION,

            ausencia_id:
              data.id,

            correlation_id:
              gate.correlationId,

            code:
              auditFieldError.code ??
              null,

            message:
              auditFieldError.message,

            details:
              auditFieldError.details ??
              null,

            hint:
              auditFieldError.hint ??
              null,
          },
        );

        throw new Error(
          `TECHNICAL_ERROR: Não foi possível registrar a auditoria da alteração. Código de suporte: ${gate.correlationId}`,
        );
      }
    }

    // ============================================================
    // 16. UPDATE REAL
    // ============================================================

    console.info("[MK9_UPDATE_DB_START]", {
      version:
        BUILD_VERSION,

      ausencia_id:
        data.id,

      correlation_id:
        gate.correlationId,

      has_updated_at:
        "updated_at" in sanitizedUpdatePayload,

      has_atualizado_em:
        "atualizado_em" in sanitizedUpdatePayload,
    });

    const {
      data: updated,
      error,
    } = await context.supabase
      .from("ausencias")
      .update(
        sanitizedUpdatePayload as never,
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
            BUILD_VERSION,

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

          has_atualizado_em:
            Object.prototype.hasOwnProperty.call(
              sanitizedUpdatePayload,
              "atualizado_em",
            ),

          has_updated_at:
            Object.prototype.hasOwnProperty.call(
              sanitizedUpdatePayload,
              "updated_at",
            ),
        },
      );

      throw ausenciaDbError(
        error,
        "update_ausencia",
        gate.correlationId,
      );
    }

    // ============================================================
    // 17. ZERO ROW GUARD
    // ============================================================

    if (!updated) {
      console.warn(
        "[MK9_UPDATE_ZERO_ROW]",
        {
          version:
            BUILD_VERSION,

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

    console.info("[MK9_UPDATE_DB_SUCCESS]", {
      version:
        BUILD_VERSION,

      ausencia_id:
        updated.id,

      status:
        updated.status,

      updated_at:
        updated.updated_at,

      correlation_id:
        gate.correlationId,
    });

    // ============================================================
    // 18. AUDITORIA PRINCIPAL
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
          sanitizedUpdatePayload.motivo,

        cid:
          sanitizedUpdatePayload.cid,

        data_inicio:
          sanitizedUpdatePayload.data_inicio,

        data_fim:
          sanitizedUpdatePayload.data_fim,

        localidade:
          sanitizedUpdatePayload.localidade,

        loja_codigo_nome:
          sanitizedUpdatePayload.loja_codigo_nome,

        acidente_trabalho_trajeto:
          sanitizedUpdatePayload.acidente_trabalho_trajeto,
      },

      "edição",

      gate.empresaId,
      gate.projetoId,
      context.userId,
    );

    // ============================================================
    // 19. NOTIFICAÇÕES
    // ============================================================

    const mudancaRelevante =
      current.data_inicio !==
        sanitizedUpdatePayload.data_inicio ||
      current.data_fim !==
        sanitizedUpdatePayload.data_fim ||
      current.tipo_detalhe !==
        sanitizedUpdatePayload.tipo_detalhe;

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
    // 20. SUCESSO
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
        BUILD_VERSION,
    };
  });
