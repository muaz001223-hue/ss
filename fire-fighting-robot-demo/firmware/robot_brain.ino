/*
 * SAFE SENSOR MONITOR ONLY.
 * This sketch reports the three analog flame sensor readings over Serial.
 * Motor, servo, and pump pins are deliberately left as INPUT and are never
 * driven. Robot motion and extinguishing behavior exist only in the Python
 * room simulation; this is not fire-response firmware.
 */

const uint8_t enA = 10;
const uint8_t in1 = 9;
const uint8_t in2 = 8;
const uint8_t in3 = 7;
const uint8_t in4 = 6;
const uint8_t enB = 5;

const uint8_t ir_R = A0;
const uint8_t ir_F = A1;
const uint8_t ir_L = A2;
const uint8_t servoPin = A4;
const uint8_t pumpPin = A5;

void setup() {
  Serial.begin(9600);

  pinMode(enA, INPUT);
  pinMode(in1, INPUT);
  pinMode(in2, INPUT);
  pinMode(in3, INPUT);
  pinMode(in4, INPUT);
  pinMode(enB, INPUT);
  pinMode(servoPin, INPUT);
  pinMode(pumpPin, INPUT);
}

void loop() {
  Serial.print(F("SENSORS,"));
  Serial.print(analogRead(ir_R));
  Serial.print(',');
  Serial.print(analogRead(ir_F));
  Serial.print(',');
  Serial.print(analogRead(ir_L));
  Serial.print(F(",0,MONITOR"));
  Serial.println();
  delay(100);
}
