import { useMemo } from 'react';
import {
  Box,
  Paper,
  TextField,
  Button,
  Typography,
  Autocomplete,
  FormControlLabel,
  Switch,
  alpha,
} from '@mui/material';
import type { RelationshipMetadata } from '../../utils/tupleHelper';
import type { DirectFormValues } from './types';

interface DirectTuplesFormProps {
  values: DirectFormValues;
  onChange: (next: DirectFormValues) => void;
  metadata?: RelationshipMetadata;
  isSubmitting: boolean;
  onSubmit: () => void;
}

export function DirectTuplesForm({
  values,
  onChange,
  metadata,
  isSubmitting,
  onSubmit,
}: DirectTuplesFormProps) {
  const availableTypes = useMemo(
    () => (metadata ? Array.from(metadata.types.keys()) : []),
    [metadata]
  );

  const availableUsersetRelations = useMemo(() => {
    if (!values.userType || !metadata) return [];
    return metadata.types.get(values.userType)?.relations || [];
  }, [values.userType, metadata]);

  const availableFilterRelations = useMemo(() => {
    if (!values.objectType || !metadata) return [];
    return metadata.types.get(values.objectType)?.relations || [];
  }, [values.objectType, metadata]);

  const update = (patch: Partial<DirectFormValues>) =>
    onChange({ ...values, ...patch });

  const buildUserPreview = (): string => {
    if (!values.userType) return '<any user>';
    if (!values.userName) return `<${values.userType} id>`;
    const base = `${values.userType}:${values.userName}`;
    if (values.isUserset && values.usersetRelation) {
      return `${base}#${values.usersetRelation}`;
    }
    return base;
  };

  const buildObjectPreview = (): string => {
    if (!values.objectType) return '<any object>';
    if (!values.objectId) return `${values.objectType}:* (any)`;
    return `${values.objectType}:${values.objectId}`;
  };

  const hasUserFilter = !!values.userType && !!values.userName;
  const hasObjectFilter = !!values.objectType;
  const hasAnyFilter =
    hasUserFilter || hasObjectFilter || !!values.filterRelation;

  return (
    <Box
      component="form"
      onSubmit={(e) => {
        e.preventDefault();
        if (hasAnyFilter && !isSubmitting) onSubmit();
      }}
      sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}
    >
      <Typography variant="body2" color="text.secondary">
        e.g. all roles assigned to <code>user:alice</code>, or all objects{' '}
        <code>role:admin#assignee</code> is referenced in
      </Typography>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
          <Autocomplete
            size="small"
            sx={{ width: 250 }}
            value={values.userType || null}
            onChange={(_, newValue) =>
              update({
                userType: newValue || '',
                usersetRelation: '',
              })
            }
            options={availableTypes}
            renderInput={(params) => (
              <TextField
                {...params}
                label="User Type"
                helperText="Optional filter"
              />
            )}
          />
          <TextField
            size="small"
            sx={{ width: 250 }}
            label="User Name"
            value={values.userName}
            onChange={(e) => update({ userName: e.target.value })}
            disabled={!values.userType}
            helperText={
              values.userType
                ? `Optional. Will filter for '${values.userType}:${values.userName || '<name>'}'`
                : 'Pick a user type first'
            }
          />
        </Box>
        <Box>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={values.isUserset}
                onChange={(e) =>
                  update({
                    isUserset: e.target.checked,
                    usersetRelation: e.target.checked
                      ? values.usersetRelation
                      : '',
                  })
                }
                disabled={!values.userType || !values.userName}
              />
            }
            label={
              <Typography variant="body2">
                This user is a <strong>userset</strong> (e.g.{' '}
                <code>role:admin#assignee</code>)
              </Typography>
            }
          />
          {values.isUserset && (
            <Box sx={{ mt: 1 }}>
              <Autocomplete
                size="small"
                sx={{ width: 350 }}
                value={values.usersetRelation || null}
                onChange={(_, newValue) =>
                  update({ usersetRelation: newValue || '' })
                }
                options={availableUsersetRelations}
                renderInput={(params) => (
                  <TextField
                    {...params}
                    label={`Relation on '${values.userType}'`}
                    helperText={`Will be sent as '${values.userType}:${values.userName || '<name>'}#<relation>'`}
                  />
                )}
              />
            </Box>
          )}
        </Box>
      </Box>

      <Box sx={{ display: 'flex', gap: 2, alignItems: 'flex-start' }}>
        <Autocomplete
          size="small"
          sx={{ width: 250 }}
          value={values.objectType || null}
          onChange={(_, newValue) =>
            update({ objectType: newValue || '', filterRelation: '' })
          }
          options={availableTypes}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Object Type"
              helperText="Required if no user filter"
            />
          )}
        />
        <TextField
          size="small"
          sx={{ width: 250 }}
          label="Object Id"
          value={values.objectId}
          onChange={(e) => update({ objectId: e.target.value })}
          disabled={!values.objectType}
          helperText={
            values.objectType
              ? `Optional. Leave blank to match all '${values.objectType}:*'`
              : 'Pick an object type first'
          }
        />
        <Autocomplete
          size="small"
          sx={{ width: 250 }}
          value={values.filterRelation || null}
          onChange={(_, newValue) =>
            update({ filterRelation: newValue || '' })
          }
          options={availableFilterRelations}
          disabled={!values.objectType}
          renderInput={(params) => (
            <TextField
              {...params}
              label="Relation"
              helperText="Optional filter"
            />
          )}
        />
      </Box>

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
              Tuples where user is
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
              {buildUserPreview()}
            </Typography>
            <Typography component="span" color="text.secondary">
              relation is
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
              {values.filterRelation || '<any>'}
            </Typography>
            <Typography component="span" color="text.secondary">
              object is
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
              {buildObjectPreview()}
            </Typography>
          </Box>
          <Button
            type="submit"
            variant="contained"
            disabled={!hasAnyFilter || isSubmitting}
          >
            {isSubmitting ? 'Reading...' : 'Read tuples'}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
