import React, { useState, useEffect, useMemo } from "react";
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  ToggleButton,
  ToggleButtonGroup,
  Autocomplete,
  alpha,
  Alert,
  Snackbar,
} from "@mui/material";
import { OpenFGAService } from "../../services/OpenFGAService";
import {
  extractRelationshipMetadata,
  type RelationshipMetadata,
  type RelationshipTuple,
} from "../../utils/tupleHelper";
import { useHistory } from "../../hooks/useHistory";
import { HistoryPanel } from "../History/HistoryPanel";
import { addHistoryEntry, type HistoryEntry } from "../../services/historyStore";

interface PendingPrefill {
  user: string;
  relation: string;
  object: string;
}

interface QueryTabProps {
  storeId: string;
  currentModel?: string;
  authModelId: string;
  pendingPrefill?: PendingPrefill | null;
  onPrefillConsumed?: () => void;
}

interface RelationOption {
  label: string;
  condition?: {
    name: string;
    parameters: {
      [key: string]: {
        type_name: string;
      };
    };
  };
}

interface ConditionState {
  name: string;
  context: Record<string, string | number | boolean>;
}

function QueryTab({
  storeId,
  currentModel,
  authModelId,
  pendingPrefill,
  onPrefillConsumed,
}: QueryTabProps) {
  const [metadata, setMetadata] = useState<RelationshipMetadata>();
  const [queryMode, setQueryMode] = useState<"form" | "text">("form");
  const [selectedType, setSelectedType] = useState("");
  const [selectedObjectType, setSelectedObjectType] = useState("");
  const [user, setUser] = useState("");
  const [relation, setRelation] = useState<RelationOption | null>(null);
  const [object, setObject] = useState("");
  const [textQuery, setTextQuery] = useState("");
  const { entries: historyEntries, remove: removeHistory, clear: clearHistory } = useHistory(storeId);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [conditionState, setConditionState] = useState<ConditionState | null>(
    null
  );
  const [pendingRelationName, setPendingRelationName] = useState<string | null>(
    null
  );
  const [pendingCondition, setPendingCondition] = useState<ConditionState | null>(
    null
  );
  const [conversionWarning, setConversionWarning] = useState<string | null>(null);
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: "success" | "error";
  }>({
    open: false,
    message: "",
    severity: "success",
  });

  // Available types from metadata
  const availableTypes = useMemo(
    () => (metadata ? Array.from(metadata.types.keys()) : []),
    [metadata]
  );

  // Available relations based on the selected object type and user type
  const availableRelations = useMemo(() => {
    if (!selectedObjectType || !metadata || !selectedType) return [];

    // Get the object type metadata
    const objectTypeMetadata = metadata.types.get(selectedObjectType);
    if (!objectTypeMetadata) return [];

    // Get all relations that accept the selected user type
    const relations = objectTypeMetadata.relations.filter((relationName) => {
      const userTypes = objectTypeMetadata.userTypes.get(relationName) || [];
      // Check if this relation accepts the selected user type
      return userTypes.some(
        (type) => type.startsWith(selectedType) || type === selectedType
      );
    });

    return relations.map((relation) => ({
      id: relation,
      label: relation,
      condition: objectTypeMetadata.conditions?.get(relation),
    }));
  }, [selectedType, selectedObjectType, metadata]);

  // Reset condition state when relation changes
  useEffect(() => {
    setConditionState(null);
  }, [relation]);

  // Apply a pending condition (e.g. from freeform->assisted conversion) after
  // the reset-on-relation-change effect above has run.
  useEffect(() => {
    if (!pendingCondition) return;
    setConditionState(pendingCondition);
    setPendingCondition(null);
  }, [pendingCondition]);

  useEffect(() => {
    if (currentModel) {
      try {
        const meta = extractRelationshipMetadata(currentModel);
        setMetadata(meta);
        // Reset form when model changes
        setSelectedType("");
        setUser("");
        setRelation(null);
        setObject("");
        setSelectedObjectType("");
        setError(null);
        setConditionState(null);
      } catch (error) {
        console.error("Failed to extract relationship metadata:", error);
        setError("Failed to parse authorization model");
      }
    }
  }, [currentModel]);

  // Query history is persisted via the shared historyStore in handleSubmit and
  // read through useHistory — no per-tab localStorage effects needed.

  useEffect(() => {
    if (!pendingPrefill) return;
    const { user, relation, object } = pendingPrefill;

    setQueryMode("form");
    setError(null);
    setConditionState(null);

    const userColon = user.indexOf(":");
    const userHash = user.indexOf("#");
    if (userColon === -1 || userHash !== -1) {
      setSelectedType("");
      setUser(user);
    } else {
      setSelectedType(user.slice(0, userColon));
      setUser(user.slice(userColon + 1));
    }

    const objectColon = object.indexOf(":");
    if (objectColon === -1) {
      setSelectedObjectType("");
      setObject(object);
    } else {
      setSelectedObjectType(object.slice(0, objectColon));
      setObject(object.slice(objectColon + 1));
    }

    setPendingRelationName(relation);
    onPrefillConsumed?.();
  }, [pendingPrefill, onPrefillConsumed]);

  useEffect(() => {
    if (!pendingRelationName) return;
    if (availableRelations.length === 0) return;
    const match = availableRelations.find(
      (r) => r.label === pendingRelationName
    );
    if (match) {
      setRelation(match);
    } else {
      setRelation({ label: pendingRelationName });
    }
    setPendingRelationName(null);
  }, [pendingRelationName, availableRelations]);

  const formatQueryAsText = (query: RelationshipTuple): string => {
    let text = `is ${query.user} related to ${query.object} as ${query.relation}`;
    if (query.condition) {
      const conditions = Object.entries(query.condition.context)
        .map(([key, value]) => `${key} as ${value}`)
        .join(", ");
      text += ` with ${conditions}`;
    }
    return text;
  };

  const parseFreeformQuery = (
    text: string
  ): { tuple: RelationshipTuple } | { error: string } => {
    const trimmed = text.trim();
    if (!trimmed) {
      return { error: "Query is empty" };
    }

    const nlRegex =
      /^is\s+(\S+)\s+related\s+to\s+(\S+)\s+as\s+(\S+?)(?:\s+with\s+(.+?))?\s*\??$/i;
    const match = trimmed.match(nlRegex);
    if (match) {
      const [, userPart, objectPart, relationPart, withClause] = match;
      const tuple: RelationshipTuple = {
        user: userPart,
        relation: relationPart,
        object: objectPart,
      };

      if (withClause) {
        const context: Record<string, string | number | boolean> = {};
        const pairs = withClause
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean);
        for (const pair of pairs) {
          const pairMatch = pair.match(/^(\S+)\s+as\s+(.+)$/);
          if (!pairMatch) {
            return { error: `Invalid condition syntax: "${pair}"` };
          }
          context[pairMatch[1]] = pairMatch[2];
        }

        const [objectType] = objectPart.split(":");
        const conditionInfo = metadata?.types
          .get(objectType)
          ?.conditions?.get(relationPart);
        if (!conditionInfo) {
          return {
            error: `No condition defined for relation "${relationPart}" on type "${objectType}"`,
          };
        }
        tuple.condition = { name: conditionInfo.name, context };
      }

      return { tuple };
    }

    try {
      const parsed = JSON.parse(trimmed) as RelationshipTuple;
      if (
        !parsed ||
        typeof parsed !== "object" ||
        typeof parsed.user !== "string" ||
        typeof parsed.relation !== "string" ||
        typeof parsed.object !== "string"
      ) {
        return {
          error: "JSON query must include user, relation, and object fields",
        };
      }
      return { tuple: parsed };
    } catch {
      return {
        error:
          'Invalid query format. Use either "is user related to object as relation" or a valid JSON object.',
      };
    }
  };

  const clearAssistedState = () => {
    setSelectedType("");
    setUser("");
    setSelectedObjectType("");
    setObject("");
    setRelation(null);
    setConditionState(null);
    setPendingCondition(null);
    setPendingRelationName(null);
  };

  // Attempt to populate the Assisted form from the current freeform textQuery.
  // Returns null on success, or a human-readable failure reason.
  const tryConvertFreeformToAssisted = (): string | null => {
    if (!textQuery.trim()) return null;

    const result = parseFreeformQuery(textQuery);
    if ("error" in result) {
      return result.error;
    }

    const { tuple } = result;

    const userColon = tuple.user.indexOf(":");
    const userHash = tuple.user.indexOf("#");
    if (userColon === -1 || userHash !== -1) {
      return `User "${tuple.user}" must be in "type:name" form to use Assisted mode`;
    }
    const userType = tuple.user.slice(0, userColon);
    const userName = tuple.user.slice(userColon + 1);

    const objectColon = tuple.object.indexOf(":");
    if (objectColon === -1) {
      return `Object "${tuple.object}" must be in "type:name" form to use Assisted mode`;
    }
    const objectType = tuple.object.slice(0, objectColon);
    const objectName = tuple.object.slice(objectColon + 1);

    if (!metadata) {
      return "No authorization model is loaded";
    }
    if (!metadata.types.has(userType)) {
      return `User type "${userType}" is not defined in the current model`;
    }
    const objectMeta = metadata.types.get(objectType);
    if (!objectMeta) {
      return `Object type "${objectType}" is not defined in the current model`;
    }
    if (!objectMeta.relations.includes(tuple.relation)) {
      return `Relation "${tuple.relation}" is not defined on type "${objectType}"`;
    }

    setSelectedType(userType);
    setUser(userName);
    setSelectedObjectType(objectType);
    setObject(objectName);
    setRelation({
      label: tuple.relation,
      condition: objectMeta.conditions?.get(tuple.relation),
    });

    if (tuple.condition) {
      setPendingCondition({
        name: tuple.condition.name,
        context: tuple.condition.context,
      });
    } else {
      setPendingCondition(null);
    }

    return null;
  };

  const handleModeChange = (newMode: "form" | "text" | null) => {
    if (!newMode || newMode === queryMode) return;
    setError(null);
    setConversionWarning(null);

    if (newMode === "form" && queryMode === "text") {
      const failure = tryConvertFreeformToAssisted();
      if (failure) {
        clearAssistedState();
        setConversionWarning(
          `Could not convert to Assisted mode: ${failure}`
        );
      }
    }

    setQueryMode(newMode);
  };

  const handleReplayQuery = (entry: HistoryEntry) => {
    setQueryMode("text");
    setTextQuery(
      formatQueryAsText({
        user: entry.user || "",
        relation: entry.relation || "",
        object: entry.object || "",
      })
    );
    setError(null);
    setConversionWarning(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    let query: RelationshipTuple | null = null;
    try {
      if (queryMode === "form") {
        const formattedUser = user.includes(":") ? user : `${selectedType}:${user}`;
        const formattedObject = object.includes(":") ? object : `${selectedObjectType}:${object}`;

        query = {
          user: formattedUser,
          relation: relation?.label || "",
          object: formattedObject,
        };

        if (relation?.condition && conditionState) {
          query.condition = {
            name: relation.condition?.name || "",
            context: conditionState.context,
          };
        }
      } else {
        const parseResult = parseFreeformQuery(textQuery);
        if ("error" in parseResult) {
          setError(parseResult.error);
          setIsSubmitting(false);
          return;
        }
        query = parseResult.tuple;
      }

      const startedAt = performance.now();
      const response = await OpenFGAService.check(storeId, query, authModelId);
      const latencyMs = performance.now() - startedAt;
      const result = response.allowed;

      // Show result in snackbar
      setSnackbar({
        open: true,
        message: result ? "Access Allowed" : "Access Denied",
        severity: result ? "success" : "error"
      });

      addHistoryEntry({
        op: "check",
        storeId,
        authModelId,
        user: query.user,
        relation: query.relation,
        object: query.object,
        context: query.condition?.context,
        outcome: result ? "allowed" : "denied",
        allowed: result,
        latencyMs,
        label: formatQueryAsText(query),
      });

      // Optionally reset form in form mode
      if (queryMode === "form") {
        setSelectedType("");
        setUser("");
        setRelation(null);
        setObject("");
        setSelectedObjectType("");
        setConditionState(null);
      }
    } catch (err) {
      console.error("Query check failed:", err);
      const errorMessage = err instanceof Error ? err.message : "Failed to check access";
      setError(errorMessage);
      setSnackbar({
        open: true,
        message: errorMessage,
        severity: "error"
      });
      if (query) {
        addHistoryEntry({
          op: "check",
          storeId,
          authModelId,
          user: query.user,
          relation: query.relation,
          object: query.object,
          outcome: "error",
          error: errorMessage,
          label: formatQueryAsText(query),
        });
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Box sx={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Header Section */}
      <Box
        sx={{
          bgcolor: "background.paper",
          p: 2,
          borderBottom: 1,
          borderColor: "divider",
        }}
      >
        <Typography variant="h6" fontSize={18} fontWeight="bold">
          Validate Access
        </Typography>
      </Box>

      {/* Content Section */}
      <Box sx={{ p: 2, flex: 1, overflow: "auto" }}>
        {/* Mode selector and form */}
        <Paper variant="outlined" sx={{ mb: 2, borderRadius: 1 }}>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              gap: 1,
              px: 2,
              py: 1.5,
              borderBottom: 1,
              borderColor: "divider",
              bgcolor: "background.default",
            }}
          >
            <Typography fontSize={14}>Mode:</Typography>
            <ToggleButtonGroup
              value={queryMode}
              exclusive
              onChange={(_, newMode) => handleModeChange(newMode)}
              size="small"
              sx={{
                "& .MuiToggleButton-root": {
                  px: 2,
                  bgcolor: "action.hover",
                  "&.Mui-selected": {
                    bgcolor: "primary.main",
                    color: "primary.contrastText",
                    "&:hover": {
                      bgcolor: "primary.dark",
                    },
                  },
                },
              }}
            >
              <ToggleButton
                value="form"
                sx={{ textTransform: "uppercase", fontSize: 13 }}
              >
                Assisted
              </ToggleButton>
              <ToggleButton
                value="text"
                sx={{ textTransform: "uppercase", fontSize: 13 }}
              >
                Freeform
              </ToggleButton>
            </ToggleButtonGroup>
          </Box>

          <Box sx={{ p: 3, bgcolor: "background.paper" }}>
            {error && (
              <Alert
                severity="error"
                variant="standard"
                sx={{
                  mb: 2,
                  backgroundColor: (theme) =>
                    alpha(theme.palette.error.main, 0.08),
                  border: "none",
                  "& .MuiAlert-icon": {
                    color: (theme) => theme.palette.error.main,
                    opacity: 0.8,
                  },
                }}
              >
                {error}
              </Alert>
            )}

            {conversionWarning && (
              <Alert
                severity="warning"
                variant="standard"
                onClose={() => setConversionWarning(null)}
                sx={{
                  mb: 2,
                  backgroundColor: (theme) =>
                    alpha(theme.palette.warning.main, 0.08),
                  border: "none",
                  "& .MuiAlert-icon": {
                    color: (theme) => theme.palette.warning.main,
                    opacity: 0.8,
                  },
                }}
              >
                {conversionWarning}
              </Alert>
            )}

            {queryMode === "form" ? (
              <Box
                component="form"
                onSubmit={handleSubmit}
                sx={{ display: "flex", flexDirection: "column", gap: 3 }}
              >
                {/* First row - User information */}
                <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
                  <Autocomplete
                    size="small"
                    sx={{ width: 250 }}
                    value={selectedType}
                    onChange={(_, newValue) => {
                      setSelectedType(newValue || "");
                      setRelation(null);
                    }}
                    options={availableTypes}
                    renderInput={(params) => (
                      <TextField {...params} label="User Type" required />
                    )}
                  />

                  <TextField
                    size="small"
                    sx={{ width: 250 }}
                    label="User Name"
                    value={user}
                    onChange={(e) => setUser(e.target.value)}
                    required
                    helperText={`Will be prefixed with '${selectedType}:'`}
                  />
                </Box>

                {/* Second row - Object information */}
                <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
                  <Autocomplete
                    size="small"
                    sx={{ width: 250 }}
                    value={selectedObjectType}
                    onChange={(_, newValue) => {
                      setSelectedObjectType(newValue || "");
                      setRelation(null);
                    }}
                    options={availableTypes}
                    renderInput={(params) => (
                      <TextField {...params} label="Object Type" required />
                    )}
                  />

                  <TextField
                    size="small"
                    sx={{ width: 250 }}
                    label="Object Name"
                    value={object}
                    onChange={(e) => setObject(e.target.value)}
                    required
                    helperText={`Will be prefixed with '${selectedObjectType}:'`}
                  />
                </Box>

                {/* Third row - Relation */}
                <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
                  <Autocomplete
                    size="small"
                    sx={{ width: 350 }}
                    value={relation}
                    onChange={(_, newValue) => {
                      setRelation(newValue);
                      setConditionState(null);
                    }}
                    options={availableRelations}
                    getOptionLabel={(option) => option.label}
                    renderInput={(params) => (
                      <TextField {...params} label="Relation" required />
                    )}
                    disabled={
                      !selectedType ||
                      !selectedObjectType ||
                      availableRelations.length === 0
                    }
                  />
                </Box>

                {/* Condition Parameters */}
                {relation?.condition && (
                  <Box
                    sx={{ display: "flex", flexDirection: "column", gap: 2 }}
                  >
                    <Typography variant="subtitle2" color="text.secondary">
                      Condition Parameters for {relation.condition?.name}
                    </Typography>
                    {Object.entries(relation.condition?.parameters || {}).map(
                      ([paramName, paramInfo]) => {
                        const paramType = paramInfo.type_name
                          .replace("TYPE_NAME_", "")
                          .toLowerCase();
                        return (
                          <TextField
                            key={paramName}
                            size="small"
                            sx={{ width: 350 }}
                            label={`${paramName} (${paramType})`}
                            value={conditionState?.context[paramName] ?? ""}
                            onChange={(e) => {
                              const conditionName = relation.condition?.name;
                              if (conditionName) {
                                setConditionState((prev) => ({
                                  name: conditionName,
                                  context: {
                                    ...(prev?.context || {}),
                                    [paramName]: e.target.value,
                                  },
                                }));
                              }
                            }}
                            required
                          />
                        );
                      }
                    )}
                  </Box>
                )}

                {/* Preview section */}
                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    bgcolor: "action.hover",
                    borderColor: "divider",
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 2,
                    }}
                  >
                    <Box
                      sx={{
                        flex: 1,
                        display: "flex",
                        flexWrap: "wrap",
                        alignItems: "center",
                        gap: 0.5,
                        fontSize: "0.9rem",
                        fontFamily: '"Roboto Mono", monospace',
                      }}
                    >
                      <Typography component="span" color="text.secondary">
                        Can
                      </Typography>
                      <Typography
                        component="span"
                        sx={{
                          color: "primary.main",
                          bgcolor: alpha("#1976d2", 0.1),
                          px: 1,
                          py: 0.5,
                          borderRadius: 1,
                        }}
                      >
                        {selectedType && user
                          ? `${selectedType}:${user}`
                          : "<user>"}
                      </Typography>

                      <Typography component="span" color="text.secondary">
                        access
                      </Typography>
                      <Typography
                        component="span"
                        sx={{
                          color: "secondary.main",
                          bgcolor: alpha("#9c27b0", 0.1),
                          px: 1,
                          py: 0.5,
                          borderRadius: 1,
                        }}
                      >
                        {selectedObjectType && object
                          ? `${selectedObjectType}:${object}`
                          : "<object>"}
                      </Typography>

                      <Typography component="span" color="text.secondary">
                        as
                      </Typography>
                      <Typography
                        component="span"
                        sx={{
                          color: "success.main",
                          bgcolor: alpha("#2e7d32", 0.1),
                          px: 1,
                          py: 0.5,
                          borderRadius: 1,
                        }}
                      >
                        {relation?.label || "<relation>"}
                      </Typography>

                      {conditionState && (
                        <>
                          <Typography component="span" color="text.secondary">
                            with
                          </Typography>
                          {Object.entries(conditionState.context).map(
                            ([key, value], i, arr) => (
                              <React.Fragment key={key}>
                                <Typography
                                  component="span"
                                  sx={{
                                    color: "info.main",
                                    bgcolor: alpha("#0288d1", 0.1),
                                    px: 1,
                                    py: 0.5,
                                    borderRadius: 1,
                                  }}
                                >
                                  {`${key} as ${value}`}
                                </Typography>
                                {i < arr.length - 1 && (
                                  <Typography
                                    component="span"
                                    color="text.secondary"
                                  >
                                    ,{" "}
                                  </Typography>
                                )}
                              </React.Fragment>
                            )
                          )}
                        </>
                      )}
                      <Typography component="span" color="text.secondary">
                        ?
                      </Typography>
                    </Box>

                    <Button
                      variant="contained"
                      type="submit"
                      disabled={
                        isSubmitting ||
                        !selectedType ||
                        !relation ||
                        !user ||
                        !object ||
                        !selectedObjectType ||
                        (relation.condition && !conditionState)
                      }
                    >
                      {isSubmitting ? "Checking..." : "Check Access"}
                    </Button>
                  </Box>
                </Paper>
              </Box>
            ) : (
              <Box sx={{ display: "flex", flexDirection: "column", gap: 3 }}>
                <TextField
                  size="small"
                  label="Query"
                  value={textQuery}
                  onChange={(e) => setTextQuery(e.target.value)}
                  multiline
                  rows={2}
                  fullWidth
                  helperText='Format: "is user:anne related to document:readme as viewer" (optionally append "with key as value, ...") or a JSON tuple'
                />

                <Paper
                  variant="outlined"
                  sx={{
                    p: 2,
                    bgcolor: "action.hover",
                    borderColor: "divider",
                  }}
                >
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 2,
                    }}
                  >
                    <Typography
                      sx={{
                        flex: 1,
                        fontFamily: '"Roboto Mono", monospace',
                        fontSize: "0.9rem",
                        color: textQuery ? "text.primary" : "text.secondary",
                      }}
                    >
                      {textQuery || "Enter your authorization query..."}
                    </Typography>

                    <Button
                      variant="contained"
                      onClick={(e) => {
                        setError(null);
                        handleSubmit(e);
                      }}
                      disabled={isSubmitting || !textQuery.trim()}
                    >
                      Check Access
                    </Button>
                  </Box>
                </Paper>
              </Box>
            )}

            {/* Result Snackbar */}
            <Snackbar
              open={snackbar.open}
              autoHideDuration={10000}
              onClose={() => setSnackbar((prev) => ({ ...prev, open: false }))}
              anchorOrigin={{ vertical: "top", horizontal: "right" }}
            >
              <Alert
                onClose={() =>
                  setSnackbar((prev) => ({ ...prev, open: false }))
                }
                severity={snackbar.severity}
                variant="filled"
                sx={{
                  width: "100%",
                  "& .MuiAlert-message": {
                    display: "flex",
                    alignItems: "center",
                    gap: 2,
                  },
                }}
              >
                <Box sx={{ display: "flex", alignItems: "center", gap: 2 }}>
                  <Typography variant="body1" sx={{ fontWeight: 500 }}>
                    {snackbar.message}
                  </Typography>
                </Box>
              </Alert>
            </Snackbar>
          </Box>
        </Paper>

        {/* Check history (persistent, per environment + store) */}
        <HistoryPanel
          entries={historyEntries}
          ops={["check"]}
          title="History"
          onReplay={handleReplayQuery}
          onDelete={removeHistory}
          onClear={clearHistory}
        />
      </Box>
    </Box>
  );
};

export default QueryTab;
