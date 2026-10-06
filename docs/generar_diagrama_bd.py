import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle, FancyBboxPatch

T = {
 'mediciones': [('PK','id','SERIAL'),('','vivienda_id','TEXT'),('','zona','TEXT'),('','nodo_id','TEXT'),('','sensor_id','TEXT'),('','variable','TEXT'),('','valor','DOUBLE'),('','unidad','TEXT'),('','numero_registro','BIGINT'),('','creado_en','TIMESTAMPTZ')],
 'sensores': [('PK','id','SERIAL'),('UK','vivienda_id','TEXT'),('UK','sensor_id','TEXT'),('','nodo_id','TEXT'),('','tipo','TEXT'),('','nombre','TEXT'),('','zona','TEXT'),('','creado_en','TIMESTAMPTZ')],
 'estado_vivienda': [('PK','vivienda_id','TEXT'),('','armado','BOOLEAN'),('','modo_silencioso','BOOLEAN'),('','actuador_activo','BOOLEAN'),('','alarma_activa','BOOLEAN'),('','alarma_motivo','TEXT'),('','alarma_sensor','TEXT'),('','actualizado_en','TIMESTAMPTZ')],
 'acciones': [('PK','id','SERIAL'),('','vivienda_id','TEXT'),('','accion','TEXT'),('','valor_anterior','TEXT'),('','valor_nuevo','TEXT'),('','usuario','TEXT'),('','creado_en','TIMESTAMPTZ')],
 'suscripciones_push': [('PK','id','SERIAL'),('','vivienda_id','TEXT'),('UK','endpoint','TEXT'),('','p256dh','TEXT'),('','auth','TEXT'),('','agente','TEXT'),('','creado_en','TIMESTAMPTZ')],
 'ajustes_servidor': [('PK','clave','TEXT'),('','valor','TEXT')],
}
W=3.3; RH=0.32; HH=0.42
pos = {'sensores':(0.4,9.3),'mediciones':(4.6,9.3),'estado_vivienda':(8.8,9.3),'ajustes_servidor':(0.4,4.7),'acciones':(4.6,4.7),'suscripciones_push':(8.8,4.7)}
fig, ax = plt.subplots(figsize=(14.5,8.2), dpi=150)
ax.set_xlim(0,14.4); ax.set_ylim(0,10.2); ax.axis('off')
geo={}
for n,cols in T.items():
    x,ytop=pos[n]; h=HH+RH*len(cols)
    ax.add_patch(Rectangle((x,ytop-h),W,h,fc='white',ec='black',lw=1.4))
    ax.add_patch(Rectangle((x,ytop-HH),W,HH,fc='#d9e2f3',ec='black',lw=1.4))
    ax.text(x+W/2,ytop-HH/2,n,ha='center',va='center',fontsize=11,fontweight='bold',family='DejaVu Sans')
    for i,(k,c,t) in enumerate(cols):
        y=ytop-HH-RH*(i+0.5)
        ax.text(x+0.1,y,k,fontsize=8,va='center',fontweight='bold',color='#7a1f1f')
        ax.text(x+0.55,y,c,fontsize=9,va='center',fontweight='bold' if k else 'normal')
        ax.text(x+W-0.1,y,t,fontsize=8,va='center',ha='right',color='#444')
        if i<len(cols)-1: ax.plot([x,x+W],[y-RH/2]*2,color='#cccccc',lw=0.6)
    geo[n]=(x,ytop,h)
def row_y(n,col):
    x,ytop,h=geo[n]
    i=[c for _,c,_ in T[n]].index(col)
    return ytop-HH-RH*(i+0.5)
def link(a,ca,b,cb,side_a,side_b,label,dy=0):
    xa,_,_=geo[a]; xb,_,_=geo[b]
    ya=row_y(a,ca); yb=row_y(b,cb)
    pa=(xa+W if side_a=='r' else xa, ya); pb=(xb+W if side_b=='r' else xb, yb)
    ax.annotate('',xy=pb,xytext=pa,arrowprops=dict(arrowstyle='-',ls=(0,(4,3)),color='#1f3b73',lw=1.3))
    mx=(pa[0]+pb[0])/2; my=(pa[1]+pb[1])/2+dy
    ax.text(mx,my+0.12,label,fontsize=8,ha='center',color='#1f3b73',bbox=dict(fc='white',ec='none',pad=0.5))
link('sensores','sensor_id','mediciones','sensor_id','r','l','1 : N')
link('estado_vivienda','vivienda_id','mediciones','vivienda_id','l','r','1 : N',dy=0.0)
# estado -> acciones & push (logical, via vivienda_id), drawn as lines to the bottom
def vlink(a,b,label,off):
    xa,ya_top,ha=geo[a]; xb,yb_top,_=geo[b]
    pa=(xa+W/2+off, ya_top-ha); pb=(xb+W/2, yb_top)
    ax.annotate('',xy=pb,xytext=pa,arrowprops=dict(arrowstyle='-',ls=(0,(4,3)),color='#1f3b73',lw=1.3))
    ax.text((pa[0]+pb[0])/2,(pa[1]+pb[1])/2,label,fontsize=8,ha='center',color='#1f3b73',bbox=dict(fc='white',ec='none',pad=0.5))
vlink('estado_vivienda','suscripciones_push','1 : N',0)
vlink('estado_vivienda','acciones','1 : N',-1.0)
ax.text(0.4,0.9,'PK: clave primaria    UK: clave única (en sensores, el par vivienda_id + sensor_id)    Línea punteada: relación lógica por vivienda_id y sensor_id.\nSe conservan como texto, sin llaves foráneas, para no adelantar el modelo relacional definitivo (semana 4 del cronograma).',fontsize=8.5,va='top')
ax.text(7.2,10.05,'Estructura de la base de datos (PostgreSQL, commit b5be6ba)',fontsize=12,fontweight='bold',ha='center')
plt.savefig('diagrama_bd.png',bbox_inches='tight',facecolor='white')
