import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TemplateError,
  formatTemplateValue,
  renderTemplate,
  templateVariables,
} from '../src/lib/bambu/template.ts';

const context = {
  bed: 55,
  nozzle: [220, 230],
  extruder: 0,
  type: ['PLA'],
  plate: 'Textured PEI Plate',
  minimum: [110.5, 96],
  maxZ: 20,
  layer: 4,
  total: 100,
};

describe('Bambu template evaluator', () => {
  test('substitutes square placeholders, vectors by current extruder, and expressions', () => {
    assert.equal(renderTemplate('M140 S[bed]\nM104 S[nozzle]', context), 'M140 S55\nM104 S220');
    assert.equal(renderTemplate('M104 S[nozzle]', context, { currentExtruder: 1 }), 'M104 S230');
    assert.equal(renderTemplate('M109 S{nozzle[extruder]-20}', context), 'M109 S200');
    assert.equal(renderTemplate('G29 A X{minimum[0]} Y{minimum[1]}', context), 'G29 A X110.5 Y96');
    assert.equal(renderTemplate('G1 F{16.8/(0.3*0.5) * 60}', context), 'G1 F6720');
    assert.equal(renderTemplate('M73 L{layer+1} of [total]', context), 'M73 L5 of 100');
    assert.equal(renderTemplate('G29.1 Z{+0.0}\nG29.1 Z{-0.04}', context), 'G29.1 Z0\nG29.1 Z-0.04');
  });

  test('evaluates if/elsif/else, string equality and boolean operators', () => {
    const template =
      '{if type[extruder]=="PLA"}{if (bed >45)||(nozzle[0] > 250)}fan{endif};pla{endif}' +
      '|{if maxZ + 100 < 100}low{elsif maxZ < 50 and not (bed == 0)}mid{else}high{endif}';
    assert.equal(renderTemplate(template, context), 'fan;pla|mid');
    assert.equal(renderTemplate('{if plate=="Cool Plate"}cool{else}other{endif}', context), 'other');
    assert.equal(renderTemplate('{if plate=="Textured PEI Plate"}G29.1 Z{-0.04}{endif}', context), 'G29.1 Z-0.04');
  });

  test('leaves ordinary G-code text and comments untouched', () => {
    const gcode = 'G1 X10 Y20 F3000 ; move (fast)\nM221 S; push\n; list [1, 2] stays\n';
    assert.equal(renderTemplate(gcode, context), gcode);
  });

  test('fails closed on unknown variables, bad indexes and type errors', () => {
    assert.throws(() => renderTemplate('M104 S[missing]', context), /Unknown template variable "missing"/);
    assert.throws(() => renderTemplate('{nozzle[5]}', context), /out of range/);
    assert.throws(() => renderTemplate('{nozzle[0.5]}', context), /integer/);
    assert.throws(() => renderTemplate('{bed[0]}', context), /not a vector/);
    assert.throws(() => renderTemplate('{plate + 1}', context), /needs numbers/);
    assert.throws(() => renderTemplate('{if bed}x{endif}', context), /true or false/);
    assert.throws(() => renderTemplate('{bed == "55"}', context), /Cannot compare/);
    assert.throws(() => renderTemplate('{bed / 0}', context), /Division by zero/);
  });

  test('rejects malformed templates', () => {
    assert.throws(() => renderTemplate('{if bed > 1}open', context), /Missing "\{endif\}"/);
    assert.throws(() => renderTemplate('text{endif}', context), /Unexpected "\{endif\}"/);
    assert.throws(() => renderTemplate('{if bed > 1}a{else}b{else}c{endif}', context), /after "\{else\}"/);
    assert.throws(() => renderTemplate('{bed', context), /Unclosed/);
    assert.throws(() => renderTemplate('bed}', context), /Unmatched/);
    assert.throws(() => renderTemplate('{}', context), /Empty/);
    assert.throws(() => renderTemplate('{bed $ 2}', context), TemplateError);
  });

  test('lists referenced variables and formats numbers without exponents', () => {
    assert.deepEqual(
      templateVariables('[bed] {if type[extruder]=="PLA"}{nozzle[extruder]}{endif} [bed]'),
      ['bed', 'type', 'extruder', 'nozzle'],
    );
    assert.equal(formatTemplateValue(523.8431830956638), '523.843');
    assert.equal(formatTemplateValue(1e-9), '0');
    assert.equal(formatTemplateValue(250), '250');
    assert.throws(() => formatTemplateValue(Infinity), /non-finite/);
  });
});
