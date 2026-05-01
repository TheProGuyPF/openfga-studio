import { useMemo } from 'react';
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  Autocomplete,
  alpha,
} from '@mui/material';
import type { RelationshipMetadata } from '../../utils/tupleHelper';
import type { EffectiveFormValues } from './types';

interface RelationOption {
  label: string;
  condition?: {
    name: string;
    parameters: {
      [key: string]: { type_name: string };
    };
  };
}

interface EffectiveAccessFormProps {
  values: EffectiveFormValues;
  onChange: (next: EffectiveFormValues) => void;
  metadata?: RelationshipMetadata;
  isSubmitting: boolean;
  onSubmit: () => void;
}

export function EffectiveAccessForm({
  values,
  onChange,
  metadata,
  isSubmitting,
  onSubmit,
}: EffectiveAccessFormProps) {
  const availableTypes = useMemo(
    () => (metadata ? Array.from(metadata.types.keys()) : []),
    [metadata]
  );

  const availableRelations = useMemo<RelationOption[]>(() => {
    if (!values.objectType || !metadata || !values.userType) return [];

    const objectTypeMetadata = metadata.types.get(values.objectType);
    if (!objectTypeMetadata) return [];

    const relations = objectTypeMetadata.relations.filter((relationName) => {
      const userTypes = objectTypeMetadata.userTypes.get(relationName) || [];
      return userTypes.some(
        (type) => type.startsWith(values.userType) || type === values.userType
      );
    });

    return relations.map((relation) => ({
      label: relation,
      condition: objectTypeMetadata.conditions?.get(relation),
    }));
  }, [values.userType, values.objectType, metadata]);

  const selectedRelationOption = useMemo<RelationOption | null>(
    () => availableRelations.find((r) => r.label === values.relation) || null,
    [availableRelations, values.relation]
  );

  const update = (patch: Partial<EffectiveFormValues>) =>
    onChange({ ...values, ...patch });

  const userPreview =
    values.userType && values.userName
      ? `${values.userType}:${values.userName}`
      : '<user>';
  const objectPreview = values.objectType ? `${values.objectType}:*` : '<type>';

  const conditionRequiredMissing =
    !!selectedRelationOption?.condition &&
    !values.conditionState;

  const canSubmit =
    !!values.userType &&
    !!values.userName &&
    !!values.relation &&
    !!values.objectType &&
    !conditionRequiredMissing;

  return (
    <Box
      component="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSubmit && !isSubmitting) onSubmit();
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
    >
      <Typography variant="body2" color="text.secondary">
        e.g. all assessments <code>user:alice</code> can <code>view</code>
      </Typography>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
        <Autocomplete
          size="small"
          sx={{ width: 250 }}
          value={values.userType || null}
          onChange={(_, newValue) =>
            update({ userType: newValue || '', relation: '', conditionState: null })
          }
          options={availableTypes}
          renderInput={(params) => (
            <TextField {...params} label="User Type" required />
          )}
        />
        <TextField
          size="small"
          sx={{ width: 250 }}
          label="User Name"
          value={values.userName}
          onChange={(e) => update({ userName: e.target.value })}
          required
          helperText={
            values.userType
              ? `Will be sent as '${values.userType}:${values.userName || '<name>'}'`
              : 'Pick a user type first'
          }
        />
      </Box>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
        <Autocomplete
          size="small"
          sx={{ width: 250 }}
          value={values.objectType || null}
          onChange={(_, newValue) =>
            update({ objectType: newValue || '', relation: '', conditionState: null })
          }
          options={availableTypes}
          renderInput={(params) => (
            <TextField {...params} label="Object Type" required />
          )}
        />
        <Autocomplete
          size="small"
          sx={{ width: 350 }}
          value={selectedRelationOption}
          onChange={(_, newValue) =>
            update({
              relation: newValue?.label || '',
              conditionState: null,
            })
          }
          options={availableRelations}
          getOptionLabel={(option) => option.label}
          isOptionEqualToValue={(o, v) => o.label === v.label}
          disabled={
            !values.userType ||
            !values.objectType ||
            availableRelations.length === 0
          }
          renderInput={(params) => (
            <TextField {...params} label="Relation" required />
          )}
        />
      </Box>

      {selectedRelationOption?.condition && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Typography variant="subtitle2" color="text.secondary">
            Condition Parameters for {selectedRelationOption.condition.name}
          </Typography>
          {Object.entries(selectedRelationOption.condition.parameters || {}).map(
            ([paramName, paramInfo]) => {
              const paramType = paramInfo.type_name
                .replace('TYPE_NAME_', '')
                .toLowerCase();
              const conditionName = selectedRelationOption.condition!.name;
              return (
                <TextField
                  key={paramName}
                  size="small"
                  sx={{ width: 350 }}
                  label={`${paramName} (${paramType})`}
                  value={values.conditionState?.context[paramName] ?? ''}
                  onChange={(e) =>
                    update({
                      conditionState: {
                        name: conditionName,
                        context: {
                          ...(values.conditionState?.context || {}),
                          [paramName]: e.target.value,
                        },
                      },
                    })
                  }
                  required
                />
              );
            }
          )}
        </Box>
      )}

      <Paper
        variant="outlined"
        sx={{ p: 2, bgcolor: 'action.hover', borderColor: 'divider' }}
      >
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 2,
          }}
        >
          <Box
            sx={{
              flex: 1,
              display: 'flex',
              flexWrap: 'wrap',
              alignItems: 'center',
              gap: 0.5,
              fontSize: '0.9rem',
              fontFamily: '"Roboto Mono", monospace',
            }}
          >
            <Typography component="span" color="text.secondary">
              Which
            </Typography>
            <Typography
              component="span"
              sx={{
                color: 'secondary.main',
                bgcolor: alpha('#9c27b0', 0.1),
                px: 1,
                py: 0.5,
                borderRadius: 1,
              }}
            >
              {objectPreview}
            </Typography>
            <Typography component="span" color="text.secondary">
              can
            </Typography>
            <Typography
              component="span"
              sx={{
                color: 'primary.main',
                bgcolor: alpha('#1976d2', 0.1),
                px: 1,
                py: 0.5,
                borderRadius: 1,
              }}
            >
              {userPreview}
            </Typography>
            <Typography component="span" color="text.secondary">
              access as
            </Typography>
            <Typography
              component="span"
              sx={{
                color: 'success.main',
                bgcolor: alpha('#2e7d32', 0.1),
                px: 1,
                py: 0.5,
                borderRadius: 1,
              }}
            >
              {values.relation || '<relation>'}
            </Typography>
            <Typography component="span" color="text.secondary">
              ?
            </Typography>
          </Box>
          <Button
            type="submit"
            variant="contained"
            disabled={!canSubmit || isSubmitting}
          >
            {isSubmitting ? 'Looking up...' : 'List objects'}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
