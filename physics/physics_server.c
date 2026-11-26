// frenslop-proto physics server: one Box3D (v0.1.0) world, driven by the Node
// game server over stdin/stdout. Same shape as box3d-net-demo's physics_server.c:
// Node owns game logic, this process owns rigid-body simulation.
//
// Protocol: one command per line, space-separated numbers. Handles are small
// non-negative integers chosen by Node (one handle space for bodies, one for joints).
//
//   g gx gy gz                                    gravity (m/s^2)
//   b h type px py pz qx qy qz qw vx vy vz wx wy wz bullet   begin body (type 0 static, 1 kinematic, 2 dynamic)
//   s B hx hy hz ox oy oz qx qy qz qw  MAT       box shape on the last begun body
//   s S r ox oy oz                     MAT       sphere
//   s C r x1 y1 z1 x2 y2 z2            MAT       capsule (segment end centers)
//   s H n x y z ... (n points)         MAT       convex hull of points
//        MAT = density friction restitution rolling
//   e h mass                                      end body; mass > 0 rescales to that mass (kg)
//   r h                                           remove body (its joints go with it)
//   t h px py pz qx qy qz qw dt                   kinematic: move to target over dt; static/dynamic: teleport
//   k h type                                      change body type
//   v h vx vy vz                                  set linear velocity
//   w h wx wy wz                                  set angular velocity
//   i h ix iy iz                                  linear impulse at center of mass (N*s)
//   f h fx fy fz                                  force at center of mass for the next step command (N)
//   j id R a b  ax ay az  dx dy dz  speed torque lo hi        hinge (revolute) about axis d at anchor a
//   j id P a b  ax ay az  dx dy dz  lo hi speed force          slider (prismatic) along axis d
//   j id S a b  ax ay az                                       ball (spherical) joint at anchor
//   j id W a b  ax ay az                                       weld at anchor
//   j id D a b  ax ay az  bx by bz  length spring hz damping  rope/spring between two anchors
//        a, b = body handles; b = -1 attaches to the fixed world. Anchors and axes are world space.
//   q id                                          remove joint
//   x dt n                                        step n times by dt, then report:
//      p h px py pz qx qy qz qw vx vy vz          a body that moved (awake dynamic/kinematic)
//      z h                                        a body that fell asleep
//      c a b speed px py pz                       impact (hit event) between bodies a and b (b = -1: ground)
//      .                                          end of report
#include "box3d/box3d.h"
#include "box3d/collision.h"
#include "box3d/math_functions.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_LINE ( 1 << 20 )
#define MAX_HULL_POINTS 256
#define GROUND_HANDLE -1

typedef struct
{
	b3BodyId id;
	int used;
	b3Vec3 force; // applied before each step of the next x command
	int hasForce;
} Body;

static b3WorldId g_world;
static b3BodyId g_ground;
static Body* g_bodies = NULL;
static int g_bodyCap = 0;
static b3JointId* g_joints = NULL;
static int g_jointCap = 0;
static unsigned char* g_jointUsed = NULL;
static int g_current = -1; // body being built by s commands
static char* g_cursor;      // tokenizer position

static double num( void )
{
	char* end;
	double v = strtod( g_cursor, &end );
	if ( end == g_cursor )
	{
		return 0.0;
	}
	g_cursor = end;
	return isfinite( v ) ? v : 0.0;
}
static int inum( void )
{
	return (int)num();
}
static b3Vec3 vec3( void )
{
	b3Vec3 v;
	v.x = (float)num();
	v.y = (float)num();
	v.z = (float)num();
	return v;
}
static b3Quat quat( void )
{
	b3Quat q;
	q.v = vec3();
	q.s = (float)num();
	float len = sqrtf( q.v.x * q.v.x + q.v.y * q.v.y + q.v.z * q.v.z + q.s * q.s );
	if ( len < 1e-6f )
	{
		q.v = (b3Vec3){ 0, 0, 0 };
		q.s = 1.0f;
		return q;
	}
	q.v.x /= len, q.v.y /= len, q.v.z /= len, q.s /= len;
	return q;
}
static void skipSpaces( void )
{
	while ( *g_cursor == ' ' || *g_cursor == '\t' )
		g_cursor++;
}

static Body* body( int h )
{
	if ( h < 0 || h >= g_bodyCap || g_bodies[h].used == 0 )
		return NULL;
	return &g_bodies[h];
}
static b3BodyId bodyOrGround( int h )
{
	if ( h == GROUND_HANDLE )
		return g_ground;
	Body* b = body( h );
	return b ? b->id : b3_nullBodyId;
}
static void ensureBody( int h )
{
	if ( h < g_bodyCap )
		return;
	int cap = g_bodyCap ? g_bodyCap : 256;
	while ( cap <= h )
		cap *= 2;
	g_bodies = realloc( g_bodies, sizeof( Body ) * cap );
	memset( g_bodies + g_bodyCap, 0, sizeof( Body ) * ( cap - g_bodyCap ) );
	g_bodyCap = cap;
}
static void ensureJoint( int h )
{
	if ( h < g_jointCap )
		return;
	int cap = g_jointCap ? g_jointCap : 64;
	while ( cap <= h )
		cap *= 2;
	g_joints = realloc( g_joints, sizeof( b3JointId ) * cap );
	g_jointUsed = realloc( g_jointUsed, cap );
	memset( g_jointUsed + g_jointCap, 0, cap - g_jointCap );
	g_jointCap = cap;
}

// ---- quaternion helpers (world-space anchors -> local joint frames) ----
static b3Quat qmul( b3Quat a, b3Quat b )
{
	return b3MulQuat( a, b );
}
static b3Quat qconj( b3Quat q )
{
	return b3Conjugate( q );
}
static b3Vec3 qrot( b3Quat q, b3Vec3 v )
{
	return b3RotateVector( q, v );
}
// rotation taking unit vector `from` onto unit vector `to`
static b3Quat fromTo( b3Vec3 from, b3Vec3 to )
{
	float len = sqrtf( to.x * to.x + to.y * to.y + to.z * to.z );
	if ( len < 1e-6f )
		return (b3Quat){ { 0, 0, 0 }, 1 };
	to.x /= len, to.y /= len, to.z /= len;
	float d = from.x * to.x + from.y * to.y + from.z * to.z;
	if ( d < -0.999999f )
	{
		// opposite: rotate 180 degrees about any axis perpendicular to `from`
		b3Vec3 axis = fabsf( from.x ) < 0.9f ? (b3Vec3){ 1, 0, 0 } : (b3Vec3){ 0, 1, 0 };
		b3Vec3 c = { from.y * axis.z - from.z * axis.y, from.z * axis.x - from.x * axis.z, from.x * axis.y - from.y * axis.x };
		float cl = sqrtf( c.x * c.x + c.y * c.y + c.z * c.z );
		return (b3Quat){ { c.x / cl, c.y / cl, c.z / cl }, 0 };
	}
	b3Vec3 c = { from.y * to.z - from.z * to.y, from.z * to.x - from.x * to.z, from.x * to.y - from.y * to.x };
	b3Quat q = { c, 1.0f + d };
	float n = sqrtf( c.x * c.x + c.y * c.y + c.z * c.z + q.s * q.s );
	q.v.x /= n, q.v.y /= n, q.v.z /= n, q.s /= n;
	return q;
}
// joint frame expressed in a body's local space
static b3Transform localFrame( b3BodyId id, b3Vec3 anchor, b3Quat frameRot )
{
	b3WorldTransform xf = b3Body_GetTransform( id );
	b3Quat inv = qconj( xf.q );
	b3Vec3 d = { anchor.x - (float)xf.p.x, anchor.y - (float)xf.p.y, anchor.z - (float)xf.p.z };
	b3Transform t;
	t.p = qrot( inv, d );
	t.q = qmul( inv, frameRot );
	return t;
}

static b3ShapeDef shapeDef( void )
{
	b3ShapeDef sd = b3DefaultShapeDef();
	sd.density = (float)num();
	sd.baseMaterial.friction = (float)num();
	sd.baseMaterial.restitution = (float)num();
	sd.baseMaterial.rollingResistance = (float)num();
	sd.enableHitEvents = true;
	sd.updateBodyMass = false; // applied once in the e command
	return sd;
}

static void cmdShape( void )
{
	Body* b = body( g_current );
	skipSpaces();
	char kind = *g_cursor++;
	if ( b == NULL )
		return;
	if ( kind == 'B' )
	{
		b3Vec3 half = vec3();
		b3Transform xf;
		xf.p = vec3();
		xf.q = quat();
		b3ShapeDef sd = shapeDef();
		half.x = fmaxf( half.x, 0.005f ), half.y = fmaxf( half.y, 0.005f ), half.z = fmaxf( half.z, 0.005f );
		b3BoxHull box = b3MakeTransformedBoxHull( half.x, half.y, half.z, xf );
		b3CreateHullShape( b->id, &sd, &box.base );
	}
	else if ( kind == 'S' )
	{
		float r = (float)num();
		b3Sphere s = { vec3(), fmaxf( r, 0.005f ) };
		b3ShapeDef sd = shapeDef();
		b3CreateSphereShape( b->id, &sd, &s );
	}
	else if ( kind == 'C' )
	{
		float r = (float)num();
		b3Capsule c;
		c.center1 = vec3();
		c.center2 = vec3();
		c.radius = fmaxf( r, 0.005f );
		b3ShapeDef sd = shapeDef();
		b3CreateCapsuleShape( b->id, &sd, &c );
	}
	else if ( kind == 'H' )
	{
		int n = inum();
		if ( n < 4 || n > MAX_HULL_POINTS )
			return;
		b3Vec3 pts[MAX_HULL_POINTS];
		for ( int i = 0; i < n; ++i )
			pts[i] = vec3();
		b3ShapeDef sd = shapeDef();
		b3HullData* hull = b3CreateHull( pts, n, 64 );
		if ( hull != NULL )
		{
			b3CreateHullShape( b->id, &sd, hull );
			b3DestroyHull( hull );
		}
	}
}

static void cmdBeginBody( void )
{
	int h = inum();
	int type = inum();
	if ( h < 0 || h > 1000000 )
		return;
	ensureBody( h );
	if ( g_bodies[h].used )
		b3DestroyBody( g_bodies[h].id );
	b3BodyDef bd = b3DefaultBodyDef();
	bd.type = type == 2 ? b3_dynamicBody : type == 1 ? b3_kinematicBody : b3_staticBody;
	bd.position = vec3();
	bd.rotation = quat();
	bd.linearVelocity = vec3();
	bd.angularVelocity = vec3();
	bd.isBullet = inum() != 0;
	bd.userData = (void*)(intptr_t)( h + 1 ); // +1 so handle 0 isn't NULL
	g_bodies[h].id = b3CreateBody( g_world, &bd );
	g_bodies[h].used = 1;
	g_bodies[h].hasForce = 0;
	g_current = h;
}

static void cmdEndBody( void )
{
	int h = inum();
	float mass = (float)num();
	Body* b = body( h );
	g_current = -1;
	if ( b == NULL )
		return;
	b3Body_ApplyMassFromShapes( b->id );
	if ( mass > 0.0f && b3Body_GetType( b->id ) == b3_dynamicBody )
	{
		// keep the shape-derived mass distribution, rescale it to the requested mass
		b3MassData md = b3Body_GetMassData( b->id );
		if ( md.mass > 0.0f )
		{
			float k = mass / md.mass;
			md.mass = mass;
			md.inertia.cx.x *= k, md.inertia.cx.y *= k, md.inertia.cx.z *= k;
			md.inertia.cy.x *= k, md.inertia.cy.y *= k, md.inertia.cy.z *= k;
			md.inertia.cz.x *= k, md.inertia.cz.y *= k, md.inertia.cz.z *= k;
			b3Body_SetMassData( b->id, md );
		}
	}
}

static void cmdJoint( void )
{
	int id = inum();
	skipSpaces();
	char kind = *g_cursor++;
	int ha = inum(), hb = inum();
	b3BodyId A = bodyOrGround( ha ), B = bodyOrGround( hb );
	if ( id < 0 || id > 1000000 || B3_IS_NULL( A ) || B3_IS_NULL( B ) || B3_ID_EQUALS( A, B ) )
		return;
	ensureJoint( id );
	if ( g_jointUsed[id] && b3Joint_IsValid( g_joints[id] ) )
		b3DestroyJoint( g_joints[id], true );
	g_jointUsed[id] = 0;
	b3Vec3 anchor = vec3();
	b3JointId jid = b3_nullJointId;

	if ( kind == 'R' || kind == 'P' )
	{
		b3Vec3 axis = vec3();
		// revolute rotates about local z, prismatic slides along local x
		b3Quat frame = fromTo( kind == 'R' ? (b3Vec3){ 0, 0, 1 } : (b3Vec3){ 1, 0, 0 }, axis );
		if ( kind == 'R' )
		{
			b3RevoluteJointDef jd = b3DefaultRevoluteJointDef();
			jd.base.bodyIdA = A, jd.base.bodyIdB = B;
			jd.base.localFrameA = localFrame( A, anchor, frame );
			jd.base.localFrameB = localFrame( B, anchor, frame );
			float speed = (float)num(), torque = (float)num(), lo = (float)num(), hi = (float)num();
			jd.enableMotor = torque > 0.0f;
			jd.motorSpeed = speed;
			jd.maxMotorTorque = torque;
			jd.enableLimit = lo < hi;
			jd.lowerAngle = fmaxf( lo, -0.99f * B3_PI );
			jd.upperAngle = fminf( hi, 0.99f * B3_PI );
			jid = b3CreateRevoluteJoint( g_world, &jd );
		}
		else
		{
			b3PrismaticJointDef jd = b3DefaultPrismaticJointDef();
			jd.base.bodyIdA = A, jd.base.bodyIdB = B;
			jd.base.localFrameA = localFrame( A, anchor, frame );
			jd.base.localFrameB = localFrame( B, anchor, frame );
			float lo = (float)num(), hi = (float)num(), speed = (float)num(), force = (float)num();
			jd.enableLimit = lo < hi;
			jd.lowerTranslation = lo;
			jd.upperTranslation = hi;
			jd.enableMotor = force > 0.0f;
			jd.motorSpeed = speed;
			jd.maxMotorForce = force;
			jid = b3CreatePrismaticJoint( g_world, &jd );
		}
	}
	else if ( kind == 'S' )
	{
		b3SphericalJointDef jd = b3DefaultSphericalJointDef();
		b3Quat I = { { 0, 0, 0 }, 1 };
		jd.base.bodyIdA = A, jd.base.bodyIdB = B;
		jd.base.localFrameA = localFrame( A, anchor, I );
		jd.base.localFrameB = localFrame( B, anchor, I );
		jid = b3CreateSphericalJoint( g_world, &jd );
	}
	else if ( kind == 'W' )
	{
		b3WeldJointDef jd = b3DefaultWeldJointDef();
		b3Quat I = { { 0, 0, 0 }, 1 };
		jd.base.bodyIdA = A, jd.base.bodyIdB = B;
		jd.base.localFrameA = localFrame( A, anchor, I );
		jd.base.localFrameB = localFrame( B, anchor, I );
		jid = b3CreateWeldJoint( g_world, &jd );
	}
	else if ( kind == 'D' )
	{
		b3Vec3 anchorB = vec3();
		float length = (float)num();
		int spring = inum();
		float hz = (float)num(), damping = (float)num();
		b3Quat I = { { 0, 0, 0 }, 1 };
		b3DistanceJointDef jd = b3DefaultDistanceJointDef();
		jd.base.bodyIdA = A, jd.base.bodyIdB = B;
		jd.base.localFrameA = localFrame( A, anchor, I );
		jd.base.localFrameB = localFrame( B, anchorB, I );
		if ( length <= 0.0f )
		{
			float dx = anchorB.x - anchor.x, dy = anchorB.y - anchor.y, dz = anchorB.z - anchor.z;
			length = sqrtf( dx * dx + dy * dy + dz * dz );
		}
		jd.length = fmaxf( length, 0.01f );
		jd.enableSpring = spring != 0;
		jd.hertz = hz;
		jd.dampingRatio = damping;
		jd.base.collideConnected = true;
		jid = b3CreateDistanceJoint( g_world, &jd );
	}
	if ( B3_IS_NON_NULL( jid ) )
	{
		g_joints[id] = jid;
		g_jointUsed[id] = 1;
	}
}

static int handleOf( b3BodyId id )
{
	if ( B3_ID_EQUALS( id, g_ground ) )
		return GROUND_HANDLE;
	intptr_t u = (intptr_t)b3Body_GetUserData( id );
	return u > 0 ? (int)( u - 1 ) : GROUND_HANDLE;
}

static void cmdStep( void )
{
	float dt = (float)num();
	int n = inum();
	if ( dt <= 0.0f || dt > 0.1f )
		dt = 1.0f / 60.0f;
	if ( n < 1 || n > 10 )
		n = 1;
	for ( int s = 0; s < n; ++s )
	{
		for ( int h = 0; h < g_bodyCap; ++h )
			if ( g_bodies[h].used && g_bodies[h].hasForce )
				b3Body_ApplyForceToCenter( g_bodies[h].id, g_bodies[h].force, true );
		b3World_Step( g_world, dt, 4 );

		b3ContactEvents ce = b3World_GetContactEvents( g_world );
		for ( int i = 0; i < ce.hitCount; ++i )
		{
			b3ContactHitEvent* e = ce.hitEvents + i;
			if ( !b3Shape_IsValid( e->shapeIdA ) || !b3Shape_IsValid( e->shapeIdB ) )
				continue;
			int a = handleOf( b3Shape_GetBody( e->shapeIdA ) );
			int b = handleOf( b3Shape_GetBody( e->shapeIdB ) );
			printf( "c %d %d %.3f %.3f %.3f %.3f\n", a, b, e->approachSpeed, (double)e->point.x, (double)e->point.y,
					(double)e->point.z );
		}
	}
	for ( int h = 0; h < g_bodyCap; ++h )
		g_bodies[h].hasForce = 0;

	// one report per body that moved during this command (the last state wins)
	b3BodyEvents be = b3World_GetBodyEvents( g_world );
	for ( int i = 0; i < be.moveCount; ++i )
	{
		b3BodyMoveEvent* e = be.moveEvents + i;
		int h = (int)( (intptr_t)e->userData - 1 );
		if ( h < 0 || body( h ) == NULL )
			continue;
		if ( e->fellAsleep )
		{
			printf( "z %d\n", h );
		}
		b3Vec3 v = b3Body_GetLinearVelocity( e->bodyId );
		printf( "p %d %.4f %.4f %.4f %.5f %.5f %.5f %.5f %.3f %.3f %.3f\n", h, (double)e->transform.p.x, (double)e->transform.p.y,
				(double)e->transform.p.z, (double)e->transform.q.v.x, (double)e->transform.q.v.y, (double)e->transform.q.v.z,
				(double)e->transform.q.s, (double)v.x, (double)v.y, (double)v.z );
	}
	printf( ".\n" );
	fflush( stdout );
}

int main( void )
{
	b3WorldDef wd = b3DefaultWorldDef();
	wd.gravity = (b3Vec3){ 0.0f, -9.8f, 0.0f };
	wd.hitEventThreshold = 0.5f; // m/s: ignore resting contact jitter
	g_world = b3CreateWorld( &wd );

	// the flat ground: a big static slab whose top face is y = 0 (asphalt)
	b3BodyDef gd = b3DefaultBodyDef();
	gd.position = (b3Vec3){ 0.0f, -1.0f, 0.0f };
	g_ground = b3CreateBody( g_world, &gd );
	b3ShapeDef sd = b3DefaultShapeDef();
	sd.baseMaterial.friction = 0.7f;
	sd.baseMaterial.restitution = 0.0f;
	b3BoxHull slab = b3MakeBoxHull( 1000.0f, 1.0f, 1000.0f );
	b3CreateHullShape( g_ground, &sd, &slab.base );

	char* line = malloc( MAX_LINE );
	while ( fgets( line, MAX_LINE, stdin ) )
	{
		g_cursor = line;
		skipSpaces();
		char cmd = *g_cursor++;
		Body* b;
		int h;
		switch ( cmd )
		{
			case 'g':
				b3World_SetGravity( g_world, vec3() );
				break;
			case 'b':
				cmdBeginBody();
				break;
			case 's':
				cmdShape();
				break;
			case 'e':
				cmdEndBody();
				break;
			case 'r':
				h = inum();
				if ( ( b = body( h ) ) )
				{
					b3DestroyBody( b->id );
					b->used = 0;
				}
				break;
			case 't':
				h = inum();
				if ( ( b = body( h ) ) )
				{
					b3WorldTransform xf;
					xf.p = vec3();
					xf.q = quat();
					float dt = (float)num();
					if ( b3Body_GetType( b->id ) == b3_kinematicBody && dt > 0.0f )
						b3Body_SetTargetTransform( b->id, xf, dt, true ); // moves smoothly and pushes what it touches
					else
						b3Body_SetTransform( b->id, xf.p, xf.q );
				}
				break;
			case 'k':
				h = inum();
				if ( ( b = body( h ) ) )
				{
					int type = inum();
					b3Body_SetType( b->id, type == 2 ? b3_dynamicBody : type == 1 ? b3_kinematicBody : b3_staticBody );
				}
				break;
			case 'v':
				h = inum();
				if ( ( b = body( h ) ) )
				{
					b3Body_SetLinearVelocity( b->id, vec3() );
					b3Body_SetAwake( b->id, true );
				}
				break;
			case 'w':
				h = inum();
				if ( ( b = body( h ) ) )
				{
					b3Body_SetAngularVelocity( b->id, vec3() );
					b3Body_SetAwake( b->id, true );
				}
				break;
			case 'i':
				h = inum();
				if ( ( b = body( h ) ) )
					b3Body_ApplyLinearImpulseToCenter( b->id, vec3(), true );
				break;
			case 'f':
				h = inum();
				if ( ( b = body( h ) ) )
				{
					b3Vec3 f = vec3();
					b->force.x = ( b->hasForce ? b->force.x : 0 ) + f.x;
					b->force.y = ( b->hasForce ? b->force.y : 0 ) + f.y;
					b->force.z = ( b->hasForce ? b->force.z : 0 ) + f.z;
					b->hasForce = 1;
				}
				break;
			case 'j':
				cmdJoint();
				break;
			case 'q':
				h = inum();
				if ( h >= 0 && h < g_jointCap && g_jointUsed[h] )
				{
					if ( b3Joint_IsValid( g_joints[h] ) )
						b3DestroyJoint( g_joints[h], true );
					g_jointUsed[h] = 0;
				}
				break;
			case 'x':
				cmdStep();
				break;
			default:
				break; // blank or unknown line: ignore
		}
	}
	b3DestroyWorld( g_world );
	return 0;
}
